import catalog from './aniimo-catalog.json' with { type: 'json' };
import portraits from './aniimo-portraits.json?v=game-heads' with { type: 'json' };

export const rosterFormName = ({ name, form }) => form ? `${name} (${form})` : name;

const normalized = text => text.toLowerCase().replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
const matches = (text, terms) => terms.every(term => text.includes(term));
const tokens = text => normalized(text).split(' ').filter(Boolean);
const entries = catalog.entries;
const byId = new Map(entries.map(entry => [entry.id, entry]));
const byName = new Map(entries.map(entry => [normalized(rosterFormName(entry)), entry]));
const catalogOrder = (a, b) => a.name.localeCompare(b.name) || Number(!!a.form) - Number(!!b.form)
    || (a.form ?? '').localeCompare(b.form ?? '');
const browse = [...entries].sort(catalogOrder);
const pageSize = 30;

export function rosterCatalogId(id, name = '') {
    return byId.get(id)?.id ?? byName.get(normalized(name))?.id;
}

export function aniimoPortrait(id) {
    return Object.hasOwn(portraits, id) ? portraits[id] : '';
}

export function searchRosterCatalog(query) {
    const terms = tokens(query);
    if (!terms.length) return [];
    return entries.filter(entry => matches(normalized(rosterFormName(entry)), terms))
        .sort((a, b) => Number(b.name.toLowerCase().startsWith(terms[0])) - Number(a.name.toLowerCase().startsWith(terms[0]))
            || catalogOrder(a, b));
}

export function attachRosterPicker(editor, { add, manual, label, paint, tr }) {
    const dialog = editor.querySelector('#roster-picker-dialog');
    const search = editor.querySelector('#roster-catalog-search');
    const results = editor.querySelector('#roster-catalog-results');
    const scrollArea = results.parentElement;
    const filterInput = editor.querySelector('#roster-filter');
    const more = dialog.querySelector('[data-catalog-more]');
    const empty = dialog.querySelector('[data-catalog-empty]');
    let shown = 0;
    let found = browse;
    let selected = null;

    function filter() {
        const terms = tokens(filterInput.value);
        for (const card of editor.querySelectorAll('[data-roster-tile]')) {
            card.hidden = !matches(normalized(label(Number(card.dataset.rosterTile))), terms);
        }
    }

    function showMore() {
        const buttons = found.slice(shown, shown + pageSize).map(entry => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'roster-tile';
            button.dataset.catalogEntry = entry.id;
            button.innerHTML = paint(entry, rosterFormName(entry));
            return button;
        });
        results.append(...buttons);
        shown += buttons.length;
        more.hidden = shown >= found.length;
        empty.hidden = found.length !== 0;
    }

    function showResults() {
        found = tokens(search.value).length ? searchRosterCatalog(search.value) : browse;
        shown = 0;
        results.replaceChildren();
        showMore();
        scrollArea.scrollTop = 0;
    }

    function select(button) {
        const entry = byId.get(button?.dataset.catalogEntry);
        if (!entry) return;
        selected = entry;
        dialog.close();
    }

    dialog.addEventListener('close', () => {
        if (!selected) return;
        filterInput.value = '';
        if (selected === 'manual') manual();
        else add(selected);
        selected = null;
    });
    dialog.querySelector('[data-catalog-manual]').addEventListener('click', () => {
        selected = 'manual';
        dialog.close();
    });
    more.addEventListener('click', () => {
        const previous = results.lastElementChild;
        showMore();
        previous?.nextElementSibling?.focus();
    });
    search.addEventListener('input', showResults);
    search.addEventListener('keydown', event => {
        const first = results.querySelector('button');
        if (!first) return;
        if (event.key === 'ArrowDown' || event.key === 'Enter') event.preventDefault();
        if (event.key === 'ArrowDown') first.focus();
        if (event.key === 'Enter') select(first);
    });
    results.addEventListener('click', event => select(event.target.closest('button')));
    filterInput.addEventListener('input', filter);
    return {
        filter,
        open() {
            search.value = '';
            showResults();
            more.textContent = tr('Load more Aniimo');
            dialog.showModal();
        },
    };
}
