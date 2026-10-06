import { UseStatement } from '../types';

/**
 * Rewrites a `use` statement holding several imports (`use A\{B, C};` or `use A, B;`)
 * without the unused ones, keeping the rest exactly as written.
 */
export function withoutEntries(statement: string, unused: UseStatement[]): string {
    const dropped = new Set(unused.map(u => u.className));
    const nameOf = (part: string) => {
        const p = part.trim().replace(/^(?:function|const)\s+/i, '');
        const alias = /\s+as\s+(\w+)$/i.exec(p);
        return alias ? alias[1] : p.slice(p.lastIndexOf('\\') + 1);
    };
    const open = statement.indexOf('{');
    const close = statement.lastIndexOf('}');
    if (open !== -1 && close > open) {
        const kept = statement.slice(open + 1, close).split(',').filter(p => p.trim() && !dropped.has(nameOf(p)));
        return statement.slice(0, open + 1) + kept.map(p => p.trim()).join(', ') + statement.slice(close);
    }
    const head = /^use\s+(?:function\s+|const\s+)?/i.exec(statement)?.[0] ?? 'use ';
    const body = statement.slice(head.length).replace(/;\s*$/, '');
    const kept = body.split(',').filter(p => p.trim() && !dropped.has(nameOf(p)));
    return head + kept.map(p => p.trim()).join(', ') + ';';
}
