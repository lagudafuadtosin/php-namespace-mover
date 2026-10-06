import * as assert from 'assert';
import { planMove, applyChanges, MoveInput } from '../core/moveRefactor';

function run(input: MoveInput): Map<string, string> {
    const plan = planMove(input);
    const out = new Map<string, string>();
    const texts = new Map([[input.moved.uri, input.moved.text], ...input.files.map(f => [f.uri, f.text] as [string, string])]);
    for (const [uri, text] of texts) { out.set(uri, text); }
    for (const file of plan?.files ?? []) {
        out.set(file.uri, applyChanges(texts.get(file.uri)!, file.changes));
    }
    return out;
}

const USER = `<?php

namespace App\\Models;

class User extends Model
{
    public static function make(): self { return new User(); }
    public function posts() { return $this->hasMany(Post::class); }
}
`;

describe('planMove', () => {
    it('moves a class to a new namespace and updates its imports and references', () => {
        const controller = `<?php

namespace App\\Http;

use App\\Models\\User;
use Illuminate\\Http\\Request;

class UserController
{
    /** @param \\App\\Models\\User $other */
    public function show(Request $request, User $user) { return \\App\\Models\\User::find(1); }
}
`;
        const out = run({
            moved: { uri: 'User.php', text: USER },
            newNamespace: 'App\\Domain',
            newClassName: 'User',
            oldNamespaceSiblings: ['Post', 'Model'],
            files: [{ uri: 'UserController.php', text: controller }],
        });

        const user = out.get('User.php')!;
        assert.ok(user.includes('namespace App\\Domain;'), user);
        assert.ok(user.includes('use App\\Models\\Model;'), user);
        assert.ok(user.includes('use App\\Models\\Post;'), user);

        const c = out.get('UserController.php')!;
        assert.ok(c.includes('use App\\Domain\\User;'), c);
        assert.ok(c.includes('@param \\App\\Domain\\User $other'), c);
        assert.ok(c.includes('return \\App\\Domain\\User::find(1);'), c);
        assert.ok(!c.includes('App\\Models\\User'), c);
    });

    it('adds an import to files that shared the old namespace', () => {
        const post = `<?php\n\nnamespace App\\Models;\n\nclass Post\n{\n    public function author(): User { return new User(); }\n}\n`;
        const out = run({
            moved: { uri: 'User.php', text: USER },
            newNamespace: 'App\\Domain',
            newClassName: 'User',
            oldNamespaceSiblings: ['Post', 'Model'],
            files: [{ uri: 'Post.php', text: post }],
        });
        const p = out.get('Post.php')!;
        assert.ok(p.includes('namespace App\\Models;\n\nuse App\\Domain\\User;'), p);
        assert.ok(p.includes('public function author(): User'), p);
    });

    it('renames a class and every short-name use of it', () => {
        const service = `<?php\n\nnamespace App\\Services;\n\nuse App\\Models\\User;\n\nclass Registrar\n{\n    public function register(User $u): User { return User::create(); }\n}\n`;
        const post = `<?php\n\nnamespace App\\Models;\n\nclass Post\n{\n    public function author(): User { return new User(); }\n}\n`;
        const out = run({
            moved: { uri: 'User.php', text: USER },
            newNamespace: 'App\\Models',
            newClassName: 'Member',
            oldNamespaceSiblings: ['Post', 'Model'],
            files: [{ uri: 'Registrar.php', text: service }, { uri: 'Post.php', text: post }],
        });

        const m = out.get('User.php')!;
        assert.ok(m.includes('class Member extends Model'), m);
        assert.ok(m.includes('return new Member();'), m);
        assert.ok(m.includes('namespace App\\Models;'), m);
        assert.ok(!m.includes('use App\\Models\\Post;'), 'same namespace needs no import');

        const r = out.get('Registrar.php')!;
        assert.ok(r.includes('use App\\Models\\Member;'), r);
        assert.ok(r.includes('register(Member $u): Member { return Member::create(); }'), r);

        const p = out.get('Post.php')!;
        assert.ok(p.includes('author(): Member { return new Member(); }'), p);
        assert.ok(!p.includes('use '), 'still the same namespace');
    });

    it('keeps an alias and leaves the aliased name alone', () => {
        const file = `<?php\n\nnamespace App\\Http;\n\nuse App\\Models\\User as Account;\n\nfunction f(Account $a) {}\n`;
        const out = run({
            moved: { uri: 'User.php', text: USER },
            newNamespace: 'App\\Models',
            newClassName: 'Member',
            oldNamespaceSiblings: [],
            files: [{ uri: 'f.php', text: file }],
        });
        const f = out.get('f.php')!;
        assert.ok(f.includes('use App\\Models\\Member as Account;'), f);
        assert.ok(f.includes('function f(Account $a)'), f);
    });

    it('updates an entry inside a grouped import', () => {
        const sameRoot = `<?php\n\nnamespace App\\Http;\n\nuse App\\{Models\\User, Models\\Post};\n\nfunction f(User $u, Post $p) {}\n`;
        const otherRoot = `<?php\n\nnamespace App\\Http;\n\nuse App\\Models\\{User, Post};\n\nfunction f(User $u, Post $p) {}\n`;
        const out = run({
            moved: { uri: 'User.php', text: USER },
            newNamespace: 'Domain\\Accounts',
            newClassName: 'User',
            oldNamespaceSiblings: [],
            files: [{ uri: 'a.php', text: sameRoot }, { uri: 'b.php', text: otherRoot }],
        });
        const a = out.get('a.php')!;
        assert.ok(a.includes('use App\\{Models\\Post};\nuse Domain\\Accounts\\User;'), a);
        const b = out.get('b.php')!;
        assert.ok(b.includes('use App\\Models\\{Post};\nuse Domain\\Accounts\\User;'), b);

        const within = run({
            moved: { uri: 'User.php', text: USER },
            newNamespace: 'App\\Domain',
            newClassName: 'User',
            oldNamespaceSiblings: [],
            files: [{ uri: 'a.php', text: sameRoot }],
        });
        assert.ok(within.get('a.php')!.includes('use App\\{Domain\\User, Models\\Post};'), within.get('a.php'));
    });

    it('does nothing to files that only mention the name for another class', () => {
        const other = `<?php\n\nnamespace Billing;\n\nuse Billing\\Entities\\User;\n\nfunction f(User $u) { return "App\\\\Models\\\\User"; }\n`;
        const out = run({
            moved: { uri: 'User.php', text: USER },
            newNamespace: 'App\\Domain',
            newClassName: 'User',
            oldNamespaceSiblings: [],
            files: [{ uri: 'other.php', text: other }],
        });
        assert.strictEqual(out.get('other.php'), other);
    });

    it('returns no plan when nothing changes', () => {
        assert.strictEqual(planMove({
            moved: { uri: 'User.php', text: USER },
            newNamespace: 'App\\Models',
            newClassName: 'User',
            oldNamespaceSiblings: [],
            files: [],
        }), null);
    });
});
