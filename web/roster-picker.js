import catalog from './aniimo-catalog.json' with { type: 'json' };

export const rosterFormName = ({ name, form }) => form ? `${name} (${form})` : name;

const normalized = text => text.toLowerCase().replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
const matches = (text, terms) => terms.every(term => text.includes(term));
const tokens = text => normalized(text).split(' ').filter(Boolean);
const entries = catalog.entries;

export function searchRosterCatalog(query) {
    const terms = tokens(query);
    if (!terms.length) return [];
    return entries.filter(entry => matches(normalized(rosterFormName(entry)), terms))
        .sort((a, b) => Number(b.name.toLowerCase().startsWith(terms[0])) - Number(a.name.toLowerCase().startsWith(terms[0]))
            || a.name.localeCompare(b.name) || Number(!!a.form) - Number(!!b.form)
            || (a.form ?? '').localeCompare(b.form ?? ''));
}

export function attachRosterPicker(editor, { add, label, tr }) {
    const search = editor.querySelector('#roster-catalog-search');
    const results = editor.querySelector('#roster-catalog-results');
    const filterInput = editor.querySelector('#roster-filter');
    const byId = new Map(entries.map(entry => [entry.id, entry]));

    function filter() {
        const terms = tokens(filterInput.value);
        for (const card of editor.querySelectorAll('[data-roster-card]')) {
            card.hidden = !matches(normalized(label(Number(card.dataset.rosterCard))), terms);
        }
    }

    function showResults() {
        const query = search.value.trim();
        results.hidden = query.length < 1;
        if (results.hidden) return;
        const found = searchRosterCatalog(query);
        const buttons = found.slice(0, 8).map(entry => {
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.catalogEntry = entry.id;
            const title = document.createElement('strong');
            title.textContent = rosterFormName(entry);
            const abilities = document.createElement('span');
            abilities.className = 'hint small';
            abilities.textContent = Object.entries(entry.abilities).map(([ability, level]) => `${tr(ability)} ${level}`).join(' · ');
            button.append(title, abilities);
            return button;
        });
        const message = document.createElement('p');
        message.className = 'hint small';
        if (!found.length) message.textContent = tr('No matching Aniimo.');
        if (found.length > buttons.length) message.textContent = tr('Type more to narrow the results.');
        results.replaceChildren(...buttons, ...(message.textContent ? [message] : []));
    }

    function select(button) {
        const entry = byId.get(button?.dataset.catalogEntry);
        if (!entry) return;
        filterInput.value = '';
        add(entry);
        search.value = '';
        showResults();
        search.focus();
    }

    search.addEventListener('input', showResults);
    search.addEventListener('keydown', event => {
        if (event.key === 'Escape') { results.hidden = true; return; }
        const first = results.querySelector('button');
        if (!first || results.hidden) return;
        if (event.key === 'ArrowDown' || event.key === 'Enter') event.preventDefault();
        if (event.key === 'ArrowDown') first.focus();
        if (event.key === 'Enter') select(first);
    });
    results.addEventListener('click', event => select(event.target.closest('button')));
    results.addEventListener('keydown', event => {
        const current = event.target.closest('button');
        if (!current) return;
        if (event.key === 'Escape') {
            results.hidden = true;
            search.focus();
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const next = event.key === 'ArrowDown' ? current.nextElementSibling : current.previousElementSibling;
            (next?.matches('button') ? next : search).focus();
        }
    });
    filterInput.addEventListener('input', filter);
    return { filter };
}
