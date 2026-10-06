import * as assert from 'assert';
import { parseAutoload, resolveNamespace } from '../core/composerParser';

describe('resolveNamespace - mappings the old matcher missed', () => {
    it('maps the project root when the base path is empty', () => {
        const autoload = parseAutoload({ autoload: { 'psr-4': { 'App\\': '' } } });
        assert.strictEqual(resolveNamespace('/Models', autoload), 'App\\Models');
        assert.strictEqual(resolveNamespace('/', autoload), 'App');
    });

    it('maps the project root when the base path is ./', () => {
        const autoload = parseAutoload({ autoload: { 'psr-4': { 'App\\': './' } } });
        assert.strictEqual(resolveNamespace('/Http/Controllers', autoload), 'App\\Http\\Controllers');
    });

    it('uses the most specific mapping', () => {
        const autoload = parseAutoload({ autoload: { 'psr-4': { 'Acme\\': 'src/', 'Acme\\Testing\\': 'src/testing/' } } });
        assert.strictEqual(resolveNamespace('/src/testing/Fakes', autoload), 'Acme\\Testing\\Fakes');
        assert.strictEqual(resolveNamespace('/src/Models', autoload), 'Acme\\Models');
    });

    it('matches whole folder names only', () => {
        const autoload = parseAutoload({ autoload: { 'psr-4': { 'App\\': 'src/' } } });
        assert.strictEqual(resolveNamespace('/srcold/Models', autoload), null);
        assert.strictEqual(resolveNamespace('/packages/src/Models', autoload), null);
    });

    it('reads Windows separators', () => {
        const autoload = parseAutoload({ autoload: { 'psr-4': { 'App\\': 'app/' } } });
        assert.strictEqual(resolveNamespace('\\app\\Models', autoload), 'App\\Models');
    });
});
