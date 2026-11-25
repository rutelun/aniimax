import { personalityLetter } from './facility-config.js';

const SWAP_UNITS = {
    second: { scale: 1 / 3600, label: 'Home Coins/s' },
    minute: { scale: 1 / 60, label: 'Home Coins/min' },
    hour: { scale: 1, label: 'Home Coins/hour' },
    day: { scale: 24, label: 'Home Coins/day' },
};

// Each tile is an independent swap measured against the same base plan.
export function renderRosterSwaps(section, report, members, translate, format, rateUnit = 'hour') {
    const grid = section.querySelector('#roster-swaps-grid');
    grid.replaceChildren();
    section.hidden = !report?.rows?.length;
    const { scale, label: unitKey } = SWAP_UNITS[rateUnit] || SWAP_UNITS.hour;
    const headingUnit = section.querySelector?.('#roster-swaps-unit');
    if (headingUnit) headingUnit.textContent = translate(unitKey);
    if (section.hidden) return;
    function portrait(member) {
        const frame = document.createElement('span');
        frame.className = 'production-portrait' + (member.prismana ? ' prismana' : '');
        frame.title = member.name;
        const art = document.createElement('span');
        art.className = 'production-portrait-art';
        const fallback = document.createElement('span');
        fallback.setAttribute('aria-hidden', 'true');
        fallback.textContent = member.name.slice(0, 2);
        art.append(fallback);
        if (member.photo) {
            const img = document.createElement('img');
            img.alt = member.name;
            img.src = member.photo;
            img.className = 'game-head';
            img.loading = 'lazy';
            img.decoding = 'async';
            img.referrerPolicy = 'no-referrer';
            img.draggable = false;
            img.onload = () => { img.classList?.add('loaded'); };
            if (img.complete && img.naturalWidth) img.classList?.add('loaded');
            art.append(img);
        }
        frame.append(art);
        return frame;
    }
    for (const row of report.rows) {
        const { from, to } = row;
        const fromMember = members[from];
        const toMember = members[to];
        if (!fromMember || !toMember) continue;
        const tile = document.createElement('div');
        tile.className = 'roster-swap';
        const scaledGain = row.gain * scale;
        const scaledTotal = row.hour * scale;
        const formatVal = v => scale < 1 && Math.abs(v) < 10 ? format(Number(v.toFixed(1))) : format(Math.round(v));
        const amount = '+' + formatVal(scaledGain);
        const unit = translate(unitKey);
        const needed = row.traits ?? [];
        const letters = needed.map(personalityLetter).filter(Boolean).join('');
        const traitNames = needed.map(t => {
            const letter = personalityLetter(t);
            const label = translate(t);
            return letter ? `${label} (${letter})` : label;
        }).join(', ');
        const summaryText = `${fromMember.name} → ${toMember.name}: ${amount} ${unit} (${formatVal(scaledTotal)} ${unit}${traitNames ? ` · ${traitNames}` : ''})`;
        tile.title = summaryText;
        tile.setAttribute('aria-label', summaryText);
        const arrow = document.createElement('span');
        arrow.className = 'roster-swap-arrow';
        arrow.textContent = '→';
        arrow.setAttribute('aria-hidden', 'true');
        const gain = document.createElement('span');
        gain.className = 'roster-swap-gain';
        gain.textContent = amount;
        tile.append(portrait(fromMember), arrow, portrait(toMember));
        if (letters) {
            const badge = document.createElement('span');
            badge.className = 'roster-swap-traits';
            badge.textContent = letters;
            badge.title = traitNames;
            tile.append(badge);
        }
        tile.append(gain);
        grid.append(tile);
    }
    if (!grid.childNodes?.length && !grid.children?.length) section.hidden = true;
}
