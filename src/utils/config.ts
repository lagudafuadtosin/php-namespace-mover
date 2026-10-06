import * as vscode from 'vscode';
import { ExtensionConfig } from '../types';

const SECTION = 'phpNamespaceMover';
/** Settings from PHP Namespace Resolver still apply until the same setting is set here. */
const LEGACY_SECTION = 'phpNamespaceResolver';

export function getConfig<K extends keyof ExtensionConfig>(key: K): ExtensionConfig[K] {
    const config = vscode.workspace.getConfiguration(SECTION);
    const own = config.inspect<ExtensionConfig[K]>(key);
    const ownSet = own && (own.globalValue !== undefined || own.workspaceValue !== undefined || own.workspaceFolderValue !== undefined);
    if (!ownSet) {
        const legacy = vscode.workspace.getConfiguration(LEGACY_SECTION).inspect<ExtensionConfig[K]>(key);
        const legacyValue = legacy?.workspaceFolderValue ?? legacy?.workspaceValue ?? legacy?.globalValue;
        if (legacyValue !== undefined) { return legacyValue; }
    }
    return config.get<ExtensionConfig[K]>(key, getDefault(key));
}

function getDefault<K extends keyof ExtensionConfig>(key: K): ExtensionConfig[K] {
    const defaults: ExtensionConfig = {
        exclude: '**/node_modules/**',
        autoSort: true,
        sortOnSave: false,
        sortMode: 'natural',
        leadingSeparator: true,
        removeOnSave: false,
        autoImportOnSave: false,
        ignoreList: [],
        highlightNotImported: true,
        highlightNotUsed: true,
    };
    return defaults[key];
}
