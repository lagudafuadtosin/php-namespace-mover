import * as vscode from 'vscode';
import * as path from 'path';
import { parseAutoload, resolveNamespace } from './composerParser';

/** The nearest composer.json above a file, up to its workspace folder. */
export async function findComposerJson(file: vscode.Uri): Promise<vscode.Uri | null> {
    const folder = vscode.workspace.getWorkspaceFolder(file);
    const root = folder ? path.normalize(folder.uri.fsPath) : null;
    let dir = path.dirname(file.fsPath);
    for (;;) {
        const candidate = vscode.Uri.file(path.join(dir, 'composer.json'));
        try {
            await vscode.workspace.fs.stat(candidate);
            return candidate;
        } catch {
            // keep looking upward
        }
        const parent = path.dirname(dir);
        if (parent === dir || (root !== null && path.normalize(dir) === root)) { return null; }
        dir = parent;
    }
}

/**
 * The namespace composer.json's PSR-4 or PSR-0 autoload gives the folder a file is in,
 * or null when there is no composer.json or no mapping covers it.
 */
export async function namespaceForFile(file: vscode.Uri): Promise<string | null> {
    const composer = await findComposerJson(file);
    if (!composer) { return null; }
    let json: any;
    try {
        json = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(composer)).toString('utf8'));
    } catch {
        return null;
    }
    const autoload = parseAutoload(json);
    const composerDir = path.dirname(composer.fsPath).replace(/\\/g, '/');
    const fileDir = path.dirname(file.fsPath).replace(/\\/g, '/');
    if (!fileDir.toLowerCase().startsWith(composerDir.toLowerCase())) { return null; }
    return resolveNamespace(fileDir.substring(composerDir.length), autoload);
}
