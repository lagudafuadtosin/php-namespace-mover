import * as assert from 'assert';
import { PhpClassDetector } from '../core/PhpClassDetector';
import { analyzePhp } from '../core/php/analysis';
import { tokenize } from '../core/php/lexer';
import { withoutEntries } from '../core/useStatementEdit';

const detector = new PhpClassDetector();

// One test per reported issue that the tokenized rewrite fixes.
describe('Reported issues', () => {
    it('#128 / #149 / #159: no runaway backtracking on nested calls', () => {
        const text = '<?php\n$cache->set(' + 'trim($a), '.repeat(200) + 'json_encode(array_values($items)));\n';
        const start = Date.now();
        detector.detectAll(text);
        assert.ok(Date.now() - start < 200);
    });

    it('#128: a large file is analysed quickly', () => {
        const method = '    public function handle(Request $request, ?User $user = null): Response\n    {\n'
            + '        $x = isset($a[\'b\']) ? reset($c) : new Collection(array_map(fn (Item $i) => $i->id, $items));\n'
            + '        return Response::json([\'ok\' => true]);\n    }\n';
        const text = '<?php\nnamespace App;\n\nclass Big {\n' + method.repeat(2000) + '}\n';
        const start = Date.now();
        const names = detector.detectAll(text);
        assert.ok(Date.now() - start < 2000, `took ${Date.now() - start} ms`);
        assert.deepStrictEqual(names.sort(), ['Collection', 'Item', 'Request', 'Response', 'User']);
    });

    it('#136: NULL in a ternary is not a class', () => {
        assert.deepStrictEqual(detector.detectAll('<?php $x = $a ? foo($b) : NULL; $y = TRUE;'), []);
    });

    it('#138: a class used only in an inline @var is used', () => {
        const text = `<?php
namespace App\\Conversation\\Model;
use App\\Conversation\\Model\\ConversationFieldModel;
class ConversationModel {
    /** @var ConversationFieldModel[] */
    public array $fields = [];
}`;
        assert.ok(detector.namesUsedByCode(text).has('ConversationFieldModel'));
    });

    it('#140: classes inside <?= ?> blocks in a template are used', () => {
        const text = `<?php use yii\\helpers\\Url; ?>\n<a href="<?= Url::to(['help/index']) ?>"><?= Yii::t('app', 'Need help?') ?></a>`;
        const used = detector.namesUsedByCode(text);
        assert.ok(used.has('Url'));
        assert.ok(used.has('Yii'));
    });

    it('#146: a typed constant with a scalar type is not a class', () => {
        const text = '<?php\nfinal readonly class SomeClass {\n    private const array PROCESS_CATEGORY_IDS = [\n        //\n    ];\n}';
        assert.deepStrictEqual(detector.detectAll(text), []);
    });

    it('#151: an anonymous class after an attribute is not a declaration', () => {
        const text = `<?php\n\nnew #[Layout('layouts.admin')] class extends Component {\n    use WithPagination;\n};`;
        const analysis = analyzePhp(text);
        assert.deepStrictEqual(analysis.declarations, []);
        const names = detector.detectAll(text);
        assert.ok(names.includes('Layout'));
        assert.ok(names.includes('Component'));
        assert.ok(names.includes('WithPagination'));
    });

    it('#152: an unused import whose class name repeats its namespace is unused', () => {
        const text = '<?php\nnamespace App;\n\nuse Carbon\\Carbon;\n\nclass Foo {}';
        assert.ok(!detector.namesUsedByCode(text).has('Carbon'));
    });

    it('#153: words in inline HTML are not classes', () => {
        const text = `<?php $this->layout('main-layout') ?>\n<h1>Page: Hello world</h1>`;
        assert.deepStrictEqual(detector.detectAll(text), []);
    });

    it('#160: a promoted property with private(set) uses its type', () => {
        const text = '<?php\nclass Foo {\n    public function __construct(private(set) Bar $bar) {}\n}';
        assert.ok(detector.namesUsedByCode(text).has('Bar'));
    });

    it('an import of a namespace used as a prefix is used', () => {
        const text = '<?php\nnamespace App;\n\nuse App\\Models;\n\nfunction make() { return new Models\\User(); }';
        assert.ok(detector.namesUsedByCode(text).has('Models'));
        assert.ok(!detector.detectAll(text).includes('User'));
    });

    it('PHP.php: a file named after the language is handled like any other', () => {
        const text = '<?php\n\nnamespace App\\PHP;\n\nclass PHP extends Base {}';
        assert.deepStrictEqual(detector.detectAll(text), ['Base']);
    });

    it('an unclosed string while typing does not hang', () => {
        const text = '<?php\n$x = "new Foo(' + 'a'.repeat(50000);
        const start = Date.now();
        tokenize(text);
        detector.detectAll(text);
        assert.ok(Date.now() - start < 200);
    });

    it('removing one unused entry keeps the rest of a grouped import', () => {
        const unused = [{ text: '', line: 0, fqcn: 'App\\Models\\Post', alias: null, className: 'Post', kind: 'class' as const }];
        assert.strictEqual(withoutEntries('use App\\Models\\{User, Post, Comment};', unused), 'use App\\Models\\{User, Comment};');
        assert.strictEqual(withoutEntries('use App\\Models\\User, App\\Models\\Post;', unused), 'use App\\Models\\User;');
    });
});
