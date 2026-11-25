import test from 'node:test';
import assert from 'node:assert/strict';
import { sharedJobs } from '../web/roster-swap-model.js';
import { fixedPosts, addPostConstraints } from '../web/roster-fixed-posts.js';
import { allowedForm, neededSwapTraits, replacementTraits, swappedTeam } from '../web/roster-swaps.js';
import { renderRosterSwaps } from '../web/roster-swap-cards.js';

const station = (facility, item_name, busy_units, crew = null, electric_level = null) => ({
    facility, item_name, busy_units, crew, electric_level, cycle_time: 20, facility_count: 1, status: 'producing',
});

const plan = {
    coin_items: [
        station('Mine', 'ore', 1, 0),
        station('Farmland', 'berry', 0.5),
        station('Jar', 'jam', 0.25, null, 2),
        station('Bench', 'planks', 0.5),
    ],
    roster_routes: [],
    staffing: [['Generator', 3, 1]],
    assumed_aniimo: [],
};

const policy = [0, 1, 2, 3].map(member => ({ member, share: 0.25 }));
const input = {
    roster: {
        members: policy.map(() => ({ count: 1 })),
        dispatch: Object.fromEntries(
            ['Mine|ore|Production', 'Jar|jam|Production', 'Bench|planks|Production', 'Farmland|berry|Production',
                'Farm|berry|Water', 'Jar|jam|Hauling'].map(key => [key, policy])
        ),
    },
};

test('find partial production only and remove occupied workers from every choice', () => {
    const draft = { ...plan, coin_items: [station('Mine', 'ore', 0.3, 0)] };
    const jobs = sharedJobs(input, [draft, plan]);
    assert.deepEqual(jobs.map(j => j.recipe), ['jam', 'planks']);
    assert.deepEqual(jobs.map(j => j.workers.map(e => e.member)), [[1, 2], [1, 2]]);
});

test('hold the measured rate and staffed post inside each counterfactual solve', () => {
    const model = {
        variable_keys: ['rate:ore__byowned:0#0', 'rate:ore__byowned:1#0', 'staff:Generator:owned:3#0'],
        recipe_options: [[0, 'ore', 'Mine', null, false], [1, 'ore', 'Mine', null, false]],
    };
    const rows = [];
    assert.ok(addPostConstraints(model, fixedPosts(plan), rows));
    assert.match(rows[0], /x0 >= 0\.05$/);
    assert.match(rows[1], /x2 >= 1$/);
    assert.equal(addPostConstraints({ ...model, recipe_options: [] }, fixedPosts(plan), []), false);
});

test('keep the occupied site when another site of the same recipe has free batches', () => {
    const step = { ...station('Bench', 'planks', 1.4), facility_count: 2 };
    const mixed = {
        ...plan,
        coin_items: [step],
        roster_routes: [0, 1].map(member => ({
            member, item: 'planks', facility: 'Bench', jobs: [['', member === 0 ? 1 : 0.4]], job_rate: (member === 0 ? 1 : 0.4) / 20,
        })),
    };
    const held = fixedPosts(mixed);
    assert.deepEqual([...held.locked.get('Bench|planks|Production')], [[0, { count: 1, rate: 0.05 }]]);
    assert.deepEqual(sharedJobs(input, [mixed])[0].workers.map(e => e.member), [1, 2]);
});

test('Prismana can take either form, other forms can only take a non-Prismana replacement', () => {
    assert.deepEqual(
        [allowedForm(true, true), allowedForm(true, false), allowedForm(false, false), allowedForm(false, true)],
        [true, true, true, false]
    );
});

test('a replacement uses the incoming copy traits and leaves the source roster intact', () => {
    const members = [
        { count: 1, abilities: { Fire: 3 }, personalities: ['Playful'] },
        { count: 2, abilities: { Dark: 4 }, personalities: ['Energetic', 'Practical'] },
    ];
    const next = swappedTeam({ roster: { members } }, { assumed_aniimo: [] }, [{ from: 0, to: 1 }]);
    assert.equal(next.members[0].count, 1);
    assert.deepEqual(next.members[0].personalities, ['Energetic', 'Practical']);
    assert.deepEqual(members[0].personalities, ['Playful']);
});

test('replacementTraits preserves recorded traits and fills open compatible pairs', () => {
    const swapInput = {
        roster: {
            members: [
                { count: 1, abilities: { Dark: 4 }, personalities: ['Instinctive'] },
                { count: 1, abilities: { Dark: 4 }, personalities: [] },
            ],
            personalities: { Cauldron: 'Energetic', Oven: 'Practical' },
        },
    };
    const finalPlan = {
        coin_items: [
            station('Cauldron', 'potion', 1),
            station('Oven', 'pie', 0.5),
        ],
    };
    const recipes = [
        { facility: 'Cauldron', name: 'potion', aniimo: ['Dark', 3] },
        { facility: 'Oven', name: 'pie', aniimo: ['Dark', 2] },
    ];
    const traits = replacementTraits(swapInput, finalPlan, recipes);
    assert.deepEqual(traits[0], ['Instinctive', 'Practical']);
    assert.deepEqual(traits[1], ['Energetic', 'Practical']);
});

test('neededSwapTraits returns only traits required to keep the swap income', () => {
    assert.deepEqual(
        neededSwapTraits(['Energetic', 'Practical', 'Faithful', 'Playful'], () => 300, 300),
        []
    );
    assert.deepEqual(
        neededSwapTraits(
            ['Energetic', 'Practical', 'Faithful', 'Playful'],
            trial => trial.includes('Faithful') ? 300 : 100,
            300
        ),
        ['Faithful']
    );
    assert.deepEqual(
        neededSwapTraits(
            ['Energetic', 'Practical', 'Faithful', 'Playful'],
            trial => trial.includes('Energetic') && trial.includes('Playful') ? 300 : 250,
            300
        ),
        ['Energetic', 'Playful']
    );
});

function fakeNode(tag) {
    const attrs = new Map();
    const classes = new Set();
    return {
        tagName: tag.toUpperCase(),
        _className: '',
        get className() { return this._className; },
        set className(v) {
            this._className = v;
            classes.clear();
            for (const c of String(v).split(/\s+/).filter(Boolean)) classes.add(c);
        },
        classList: {
            add(c) { classes.add(c); },
            has(c) { return classes.has(c); },
        },
        title: '',
        textContent: '',
        hidden: false,
        children: [],
        get childNodes() { return this.children; },
        setAttribute(name, value) { attrs.set(name, String(value)); },
        getAttribute(name) { return attrs.get(name); },
        append(...items) { this.children.push(...items); },
        replaceChildren(...items) { this.children = [...items]; },
    };
}

test('renderRosterSwaps renders flat hex tiles with concise needed trait letters', () => {
    const previousDocument = globalThis.document;
    globalThis.document = { createElement: fakeNode };
    try {
        const grid = fakeNode('div');
        const section = fakeNode('section');
        section.querySelector = selector => selector === '#roster-swaps-grid' ? grid : null;

        const members = [
            { name: 'Magmarex', photo: 'https://cdn.example/UI_PetHead_1.webp', prismana: true },
            { name: 'Royalby', photo: '', prismana: false },
        ];
        renderRosterSwaps(section, { rows: [] }, members, s => s, n => String(n));
        assert.equal(section.hidden, true);
        assert.equal(grid.children.length, 0);

        const report = {
            rows: [
                { from: 0, to: 1, gain: 675.4, hour: 297893.1, traits: [] },
                { from: 0, to: 1, gain: 96.8, hour: 297315.0, traits: ['Faithful', 'Playful'] },
            ],
        };
        const tr = s => ({ 'Home Coins/hour': 'Монеты дома/ч', Faithful: 'Верный', Playful: 'Игривый' }[s] ?? s);
        renderRosterSwaps(section, report, members, tr, n => String(n));
        assert.equal(section.hidden, false);
        assert.equal(grid.children.length, 2);

        const [first, second] = grid.children;
        assert.equal(first.tagName, 'DIV');
        assert.equal(first.className, 'roster-swap');
        // No traits badge when none are needed: [from, arrow, to, gain]
        assert.equal(first.children.length, 4);
        assert.equal(first.children[0].className, 'production-portrait prismana');
        const img = first.children[0].children[0].children[1];
        assert.equal(img.className, 'game-head');
        assert.equal(img.referrerPolicy, 'no-referrer');
        img.onload();
        assert.equal(img.classList.has('loaded'), true);
        assert.equal(first.children[3].textContent, '+675');

        // Concise trait letters when traits are needed: [from, arrow, to, traits, gain]
        assert.equal(second.children.length, 5);
        assert.equal(second.children[3].className, 'roster-swap-traits');
        assert.equal(second.children[3].textContent, 'FP');
        assert.equal(second.children[3].title, 'Верный (F), Игривый (P)');
        assert.equal(second.children[4].textContent, '+97');
    } finally {
        globalThis.document = previousDocument;
    }
});
