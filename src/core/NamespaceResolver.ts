import * as vscode from 'vscode';
import { ResolvedNamespace } from '../types';
import { builtInClasses } from '../data/builtInClasses';
import { declaredClasses } from './php/analysis';
import { getConfig } from '../utils/config';
import { NamespaceCache } from './NamespaceCache';

export class NamespaceResolver {
    constructor(private cache: NamespaceCache) {}

    async resolve(className: string): Promise<ResolvedNamespace[]> {
        const results: ResolvedNamespace[] = [];

        const cached = this.cache.lookup(className);
        if (cached.length > 0) {
            for (const entry of cached) {
                const source = entry.uri.fsPath.replace(/\\/g, '/').includes('/vendor/') ? 'vendor' : 'project';
                results.push({ fqcn: entry.fqcn, source });
            }
        } else {
            const found = await this.searchFiles(className);
            results.push(...found);
        }

        if (builtInClasses.has(className)) {
            results.unshift({ fqcn: className, source: 'builtin' });
        }

        if (results.length === 0) {
            const files = await this.findFiles(className);
            if (files.length > 0) {
                results.push({ fqcn: className, source: 'global' });
            }
        }

        const priority: Record<string, number> = { builtin: 0, global: 1, project: 2, vendor: 3 };
        results.sort((a, b) => priority[a.source] - priority[b.source]);

        return results;
    }

    async pickNamespace(namespaces: ResolvedNamespace[]): Promise<string | undefined> {
        if (namespaces.length === 0) {
            return undefined;
        }

        if (namespaces.length === 1) {
            return namespaces[0].fqcn;
        }

        const items = namespaces.map(ns => ns.fqcn);
        return vscode.window.showQuickPick(items, {
            placeHolder: 'Select the namespace to import',
        });
    }

    /**
     * Find PHP files matching the given class name.
     * Scopes search to the workspace folder containing the active file
     * for multi-root workspace support.
     */
    private async findFiles(className: string): Promise<vscode.Uri[]> {
        const exclude = getConfig('exclude');
        const editor = vscode.window.activeTextEditor;

        if (editor) {
            const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
            if (folder) {
                const pattern = new vscode.RelativePattern(folder, `**/${className}.php`);
                return vscode.workspace.findFiles(pattern, exclude);
            }
        }

        return vscode.workspace.findFiles(`**/${className}.php`, exclude);
    }

    private async searchFiles(className: string): Promise<ResolvedNamespace[]> {
        const files = await this.findFiles(className);
        const results: ResolvedNamespace[] = [];
        const seen = new Set<string>();

        for (const file of files) {
            const fileName = file.fsPath.replace(/^.*[\\/]/, '').split('.')[0];
            if (fileName !== className) { continue; }

            try {
                const raw = await vscode.workspace.fs.readFile(file);
                const text = Buffer.from(raw).toString('utf8');

                // The file's own declaration of the class, in whichever namespace block it is.
                // Global classes are left to the 'global' result in resolve().
                for (const declared of declaredClasses(text)) {
                    if (declared.className !== className || !declared.fqcn.includes('\\')) { continue; }
                    if (!seen.has(declared.fqcn)) {
                        seen.add(declared.fqcn);
                        const source = file.fsPath.replace(/\\/g, '/').includes('/vendor/') ? 'vendor' : 'project';
                        results.push({ fqcn: declared.fqcn, source });
                    }
                }
            } catch {}
        }

        return results;
    }
}
