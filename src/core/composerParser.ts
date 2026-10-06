import { ComposerAutoload, PsrMapping } from '../types';

export function parseAutoload(composerJson: any): ComposerAutoload {
    const psr4: PsrMapping[] = [];
    const psr0: PsrMapping[] = [];

    const autoload = composerJson.autoload || {};
    const autoloadDev = composerJson['autoload-dev'] || {};

    const psr4Config = { ...autoload['psr-4'], ...autoloadDev['psr-4'] };
    for (const [ns, paths] of Object.entries(psr4Config)) {
        const normalizedPaths = Array.isArray(paths) ? paths : [paths as string];
        psr4.push({
            namespace: ns.replace(/\\$/, ''),
            paths: normalizedPaths.map(p => p.replace(/\/$/, '')),
        });
    }

    const psr0Config = { ...autoload['psr-0'], ...autoloadDev['psr-0'] };
    for (const [ns, paths] of Object.entries(psr0Config)) {
        const normalizedPaths = Array.isArray(paths) ? paths : [paths as string];
        psr0.push({
            namespace: ns.replace(/\\$/, ''),
            paths: normalizedPaths.map(p => p.replace(/\/$/, '')),
        });
    }

    return { psr4, psr0 };
}

/**
 * The namespace for a folder, given as a path relative to composer.json (`/src/Models`).
 * The most specific mapping wins (the longest base path that contains the folder), PSR-4
 * before PSR-0. A base path of "" or "./" maps the project root.
 */
export function resolveNamespace(relativePath: string, autoload: ComposerAutoload): string | null {
    const folder = segments(relativePath);

    const match = (mappings: PsrMapping[]) => {
        let best: { mapping: PsrMapping; base: string[] } | null = null;
        for (const mapping of mappings) {
            for (const basePath of mapping.paths) {
                const base = segments(basePath);
                const inside = base.length <= folder.length && base.every((part, k) => part === folder[k]);
                if (inside && (!best || base.length > best.base.length)) { best = { mapping, base }; }
            }
        }
        return best;
    };

    const psr4 = match(autoload.psr4);
    if (psr4) {
        return [psr4.mapping.namespace, ...folder.slice(psr4.base.length)].filter(Boolean).join('\\') || null;
    }

    // PSR-0: the folders under the base path already spell out the namespace
    const psr0 = match(autoload.psr0);
    if (psr0) {
        const rest = folder.slice(psr0.base.length);
        return rest.length > 0 ? rest.join('\\') : psr0.mapping.namespace;
    }

    return null;
}

function segments(p: string): string[] {
    return p.replace(/\\/g, '/').split('/').filter(part => part !== '' && part !== '.');
}
