import { Subject, Subscription, take } from 'rxjs';
import { Rule } from './rules/rule';
import { RuleFactory } from './rules/ruleFactory';
import * as vscode from 'vscode';
import debounce from 'debounce';
import { LocationState, reverseMap } from './rules/locationState';
import { LineRange } from './rules/line-range';

export class DecorationTypeManager {
    private _destroy = new Subject<void>();
    private _decorationSet = new Set<vscode.TextEditorDecorationType>();
    private _subscriptions: Subscription[] = [];
    private _activeEditor: vscode.TextEditor | undefined = undefined;
    private _disposables: { dispose(): void }[] = [];
    private _factoryToDecorations: Map<
        LocationState,
        Set<vscode.TextEditorDecorationType>
    > = new Map();
    private _ruleToDecorationType = new Map<
        string,
        vscode.TextEditorDecorationType
    >();
    private _ruleToActiveOccurrences = new Map<string, vscode.Range[]>();
    private _factoryToOldEnabledRules: Map<LocationState, Rule[]> = new Map();
    private _activeDecorations: Map<
        vscode.TextEditorDecorationType,
        vscode.DecorationOptions[]
    > = new Map();

    constructor(
        private _ruleFactories: RuleFactory[],
        private logger: vscode.LogOutputChannel,
    ) {
        _ruleFactories.forEach((factory) => {
            this._factoryToDecorations.set(factory.location, new Set());
        });
    }

    enableDecorationDetection() {
        this._ruleFactories.forEach((ruleFactory) => {
            this.logger.info(
                `${ruleFactory.rulesCount} ${reverseMap(ruleFactory.location)} rules loaded.`,
            );
            this.logger.info(
                `${ruleFactory.enabledRulesCount} ${reverseMap(ruleFactory.location)} rules enabled.`,
            );
            this._subscriptions.push(
                ruleFactory.$enabledRules.subscribe({
                    next: (enabledRules: Rule[]) => {
                        if (
                            this.isDecorationChangeInArray(
                                enabledRules,
                                ruleFactory.location,
                            )
                        ) {
                            this.logger.debug(
                                `[DTM][${reverseMap(ruleFactory.location)}] Decoration Detection: decoration update is needed!`,
                            );
                            this.clearDecorationsByFactory(ruleFactory);
                            this.updateDecorations(enabledRules, ruleFactory);
                        } else {
                            this.logger.debug(
                                '[DTM] Decoration Detection: No decoration update needed',
                            );
                            //we could reapply all decorations here, if we wanted to.
                        }
                        this._factoryToOldEnabledRules.set(
                            ruleFactory.location,
                            enabledRules,
                        );
                    },
                }),
            );
        });

        this._activeEditor = vscode.window.activeTextEditor;
        if (this._activeEditor) {
            if (
                this._activeEditor.document.fileName ===
                'stneveadomi.grepc.grepc'
            ) {
                this._activeEditor = undefined;
            } else {
                this._triggerUpdateDecorations();
            }
        }
        vscode.window.onDidChangeActiveTextEditor(
            (editor) => {
                this.logger.debug(
                    `[DTM] Active text editor changed from ${this._activeEditor?.document.fileName} to ${editor?.document?.fileName}`,
                );
                this.clearAllDecorations();
                // clear all decorations before switching to active editor.
                this._activeEditor = editor;

                // prevent decorating the grepc log, as this will cause an infinite loop...
                if (
                    this._activeEditor &&
                    this._activeEditor.document.fileName ===
                        'stneveadomi.grepc.grepc'
                ) {
                    this._activeEditor = undefined;
                }

                this._factoryToOldEnabledRules.clear();

                if (this._activeEditor) {
                    this.triggerUpdateDecorations();
                } else {
                    this.pushEmptyOccurrenceData();
                    this._ruleToDecorationType.clear();
                }
            },
            this,
            this._disposables,
        );

        vscode.workspace.onDidChangeTextDocument(
            (event: vscode.TextDocumentChangeEvent) => {
                // Clear old enabled rules to force isDecorationChangeInArray to return true
                // This forces updateDecorations to call.
                if (event.document === this._activeEditor?.document) {
                    this.logger.debug(
                        `[DTM] Text document changed, triggering update decorations on ${event.document.fileName} because of reason: ${event.reason}`,
                        event.contentChanges,
                    );
                    this._factoryToOldEnabledRules.clear();
                    this.triggerUpdateDecorations();
                }
            },
            this._disposables,
        );
    }

    disableDecorationDetection() {
        this._subscriptions.forEach((subscription) => {
            subscription.unsubscribe();
        });
    }

    private lastActiveEditor: vscode.TextEditor | undefined = undefined;

    updateDecorations(enabledRules: Rule[], ruleFactory: RuleFactory) {
        if (ruleFactory.locked) {
            /* This is here to prevent a strange race condition where the map was not properly updated. */
            this.logger.debug(
                'updateDecorations: ruleFactory is locked for update. Try again next time :)',
            );
            return;
        }

        this.logger.debug(
            `[DTM] Applying decorations to active editor: ${this._activeEditor?.document?.fileName}`,
        );
        if (!this._activeEditor) {
            this.logger.error(
                `[DTM] Cannot apply decorations to falsey active editor`,
                this._activeEditor,
            );
            enabledRules.forEach((rule) => {
                ruleFactory.pushOccurrences(rule, [], 0);
            });
            return;
        }

        if (this._activeEditor !== this.lastActiveEditor) {
            this.lastActiveEditor = this._activeEditor;
            // if a new active editor, clear the decoration type map.
            this._ruleToDecorationType.clear();
        }

        this.clearDecorationsByFactory(ruleFactory);
        this.logger.debug(
            `[DTM] Applying ${enabledRules.length} rules to document: ${this._activeEditor.document.fileName}`,
        );
        for (const rule of enabledRules) {
            if (rule.excludedFiles) {
                const exclude = new RegExp(rule.excludedFiles);
                if (exclude.test(this._activeEditor.document.fileName)) {
                    this.logger.debug(
                        `[DTM] Decorations not applied for rule ${rule.title}. Document title does match exclude.`,
                    );
                    ruleFactory.pushOccurrences(rule, [], 0);
                    continue;
                }
            }
            if (rule.includedFiles) {
                const include = new RegExp(rule.includedFiles);
                if (!include.test(this._activeEditor.document.fileName)) {
                    this.logger.debug(
                        `[DTM] Decorations not applied for rule ${rule.title}. Document title does not match include.`,
                    );
                    ruleFactory.pushOccurrences(rule, [], 0);
                    continue;
                }
            }
            if (!rule.regularExpression) {
                ruleFactory.pushOccurrences(rule, [], 0);
                continue;
            }
            this.logger.debug(
                `[DTM] Applying ${rule.title} to document: ${this._activeEditor.document.fileName}`,
            );
            try {
                const regEx = new RegExp(
                    rule.regularExpression,
                    rule.regularExpressionFlags || 'g',
                );
                const text = this._activeEditor.document.getText();
                const decorations: vscode.DecorationOptions[] = [];
                const ranges: vscode.Range[] = [];
                let match;
                let occurrence = 0;
                while (
                    (match = regEx.exec(text)) &&
                    decorations.length < (rule.maxOccurrences ?? 1000)
                ) {
                    occurrence++;
                    const startPos = this._activeEditor.document.positionAt(
                        match.index,
                    );
                    const endPos = this._activeEditor.document.positionAt(
                        match.index + match[0].length,
                    );
                    const range = new vscode.Range(startPos, endPos);
                    const decoration = {
                        range: range,
                        hoverMessage: `Rule: ${rule.title}\n #${occurrence}`,
                    };
                    decorations.push(decoration);
                    ranges.push(range);
                }
                this._ruleToActiveOccurrences.set(rule.id, ranges);
                ruleFactory.pushOccurrences(
                    rule,
                    DecorationTypeManager.toLineRanges(rule.id, ranges),
                    decorations.length,
                );
                const textEditorDecorationType =
                    this.getTextEditorDecorationType(rule);
                this._factoryToDecorations
                    .get(ruleFactory.location)
                    ?.add(textEditorDecorationType);
                this._activeDecorations.set(
                    textEditorDecorationType,
                    decorations,
                );

                this.logger.debug(
                    `[DTM] Applying ${decorations.length} decorations from ${rule.title} to document: ${this._activeEditor.document.fileName}`,
                );
                this._activeEditor.setDecorations(
                    textEditorDecorationType,
                    decorations,
                );
            } catch {
                this.logger.debug(
                    `[DTM] Invalid regular expression ${rule.regularExpression} for rule ${rule.title}. Pushing 0 occurrences to webview.`,
                );
                ruleFactory.pushOccurrences(rule, [], 0);
            }
        }
    }

    applyActiveDecorations() {
        if (this._activeEditor) {
            this._activeDecorations.forEach((decorations, decorationType) => {
                this._activeEditor?.setDecorations(decorationType, decorations);
            });
        }
    }

    private isDecorationChangeInArray(
        enabledRules: Rule[],
        location: LocationState,
    ) {
        const oldEnabledRules = this._factoryToOldEnabledRules.get(location);
        if (enabledRules.length !== oldEnabledRules?.length) {
            return true;
        }

        for (let i = 0; i < enabledRules.length; i++) {
            const element = enabledRules[i];
            const matchingOldRule = oldEnabledRules[i];
            if (!matchingOldRule || element.id !== matchingOldRule.id) {
                // if different ids, than a reorder happened indicating redecorate.
                return true;
            }

            //check all properties that correspond to needing a decoration update.
            if (
                matchingOldRule.backgroundColor !== element.backgroundColor ||
                matchingOldRule.border !== element.border ||
                matchingOldRule.borderColor !== element.borderColor ||
                matchingOldRule.borderWidth !== element.borderWidth ||
                matchingOldRule.color !== element.color ||
                matchingOldRule.cursor !== element.cursor ||
                matchingOldRule.excludedFiles !== element.excludedFiles ||
                matchingOldRule.includedFiles !== element.includedFiles ||
                matchingOldRule.fontStyle !== element.fontStyle ||
                matchingOldRule.fontWeight !== element.fontWeight ||
                matchingOldRule.isWholeLine !== element.isWholeLine ||
                matchingOldRule.maxOccurrences !== element.maxOccurrences ||
                matchingOldRule.outline !== element.outline ||
                matchingOldRule.outlineColor !== element.outlineColor ||
                matchingOldRule.outlineWidth !== element.outlineWidth ||
                matchingOldRule.overviewRulerColor !==
                    element.overviewRulerColor ||
                matchingOldRule.overviewRulerLane !==
                    element.overviewRulerLane ||
                matchingOldRule.regularExpression !==
                    element.regularExpression ||
                matchingOldRule.regularExpressionFlags !==
                    element.regularExpressionFlags ||
                matchingOldRule.textDecoration !== element.textDecoration ||
                matchingOldRule.title !== element.title
            ) {
                return true;
            }
        }

        return false;
    }

    private static toLineRanges(
        ruleId: string,
        ranges: vscode.Range[],
    ): LineRange[] {
        const occurrences: LineRange[] = [];
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
            ranges.forEach((range, index) => {
                const lineStart = activeEditor.document.lineAt(range.start.line)
                    .range.start;
                const lineStartOffset =
                    activeEditor.document.offsetAt(lineStart);
                const lineNumbers = [];
                for (let i = range.start.line; i <= range.end.line; i++) {
                    lineNumbers.push(i);
                }
                const lines = lineNumbers.map(
                    (lineNumber) =>
                        activeEditor.document.lineAt(lineNumber).text,
                );
                occurrences.push({
                    ruleId,
                    index,
                    lines,
                    lineNumbers,
                    startIndex:
                        activeEditor.document.offsetAt(range.start) -
                        lineStartOffset,
                    endIndexExcl:
                        activeEditor.document.offsetAt(range.end) -
                        lineStartOffset,
                    selectionNumber: index,
                });
            });
        }

        return occurrences;
    }

    private _triggerUpdateDecorations = () => {
        this.logger.debug(
            '[DTM] Triggering decoration update to all rule factories.',
        );
        if (!this._activeEditor) {
            this.logger.error(
                '[DTM] Unable to recast enabled rules as _activeEditor is undefined.',
            );
            this.pushEmptyOccurrenceData();
            return;
        }

        this._ruleFactories.forEach((ruleFactory) => {
            ruleFactory.recastEnabledRules();
        });
    };

    public triggerUpdateDecorations = debounce(
        this._triggerUpdateDecorations,
        300,
        { immediate: true },
    );

    private pushEmptyOccurrenceData() {
        this._ruleFactories.forEach((ruleFactory) => {
            // take 1 and complete, this should be the last value sent as we shareReplay $enabledRules.
            ruleFactory.$enabledRules
                .pipe(take(1))
                .subscribe((enabledRules) => {
                    enabledRules.forEach((rule) =>
                        ruleFactory.pushOccurrences(rule, [], 0),
                    );
                });
        });
        /* Clear active occurrences as we just pushed empty occurrence data. */
        this._ruleToActiveOccurrences.clear();
    }

    /**
     * Manually retrieve latest enabled rules and force decoration update on both rule factories.
     */
    public forceDecorationUpdate() {
        this._ruleFactories.forEach((ruleFactory) => {
            // take 1 and complete, this should be the last value sent as we shareReplay $enabledRules.
            ruleFactory.$enabledRules
                .pipe(take(1))
                .subscribe((enabledRules) => {
                    this.updateDecorations(enabledRules, ruleFactory);
                });
        });
    }

    clearAllDecorations() {
        this.logger.debug('[DTM] Clearing all decorations on active editor');
        this._decorationSet.forEach((decorationType) => {
            this._activeEditor?.setDecorations(decorationType, []);

            if (!this._activeEditor) {
                this.logger.debug(
                    '[DTM] clearAllDecorations()::_active editor is undefined for key: ',
                    decorationType.key,
                );
            }
        });

        this._decorationSet.clear();
        this._activeDecorations.clear();
        this._ruleToActiveOccurrences.clear();
    }

    clearDecorations(rule: Rule) {
        if (this._ruleToDecorationType.has(rule.id)) {
            this.logger.debug(
                `[DTM] Clearing decorations on rule ${rule.title}`,
            );
            this._activeEditor?.setDecorations(
                this._ruleToDecorationType.get(rule.id)!,
                [],
            );
        }
    }

    clearDecorationsByFactory(ruleFactory: RuleFactory) {
        const setDecorations = this._factoryToDecorations.get(
            ruleFactory.location,
        );
        this.logger.debug(
            `[DTM] Clearing decorations on rule factory ${reverseMap(ruleFactory.location)}`,
        );
        for (const decorationType of setDecorations ?? []) {
            this._activeEditor?.setDecorations(decorationType, []);
        }
    }

    getTextEditorDecorationType(rule: Rule): vscode.TextEditorDecorationType {
        // if rule decoration type exists, clear the decorations on it.
        this.clearDecorations(rule);

        const decType = vscode.window.createTextEditorDecorationType({
            backgroundColor: rule.backgroundColor ?? '',
            outline: rule.outline ?? '',
            outlineColor: rule.outlineColor ?? '',
            outlineWidth: rule.outlineWidth ?? '',

            border: rule.border ?? '',
            borderColor: rule.borderColor ?? '',
            borderWidth: rule.borderWidth ?? '',

            color: rule.color ?? '',

            fontStyle: rule.fontStyle ?? '',
            fontWeight: rule.fontWeight ?? '',

            textDecoration: rule.textDecoration ?? '',

            cursor: rule.cursor ?? '',
            isWholeLine: rule.isWholeLine ?? false,
            overviewRulerColor: rule.overviewRulerColor ?? '',
            overviewRulerLane: rule.overviewRulerLane
                ? Number(rule.overviewRulerLane)
                : vscode.OverviewRulerLane.Full,
        });

        this._ruleToDecorationType.set(rule.id, decType);
        this._decorationSet.add(decType);
        return decType;
    }

    dispose(): void {
        throw new Error('Method not implemented.');
    }

    jumpToLine(lineRange: LineRange) {
        const range = this._ruleToActiveOccurrences.get(lineRange?.ruleId)?.[
            lineRange.index
        ];
        if (range) {
            this.logger.debug(
                '[DTM] jumpToLine() - range found, jumping to in editor',
                this._activeEditor,
            );
            if (this._activeEditor) {
                this._activeEditor.revealRange(
                    range,
                    vscode.TextEditorRevealType.AtTop,
                );
            } else {
                this.logger.error(
                    '[DTM] Attempting to jump failed as active editor is nullish. Range:',
                    range,
                );
            }
        }
    }
}
