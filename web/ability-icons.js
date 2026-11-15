// Homeland work symbols. View-box units keep the same shapes sharp on the roster and map.
const shapes = {
    Fire: '<path fill="currentColor" d="M12 1c2 5 6 6 6 11 1-1 2-2 2-4 4 6 2 14-8 14C5 22 2 16 4 11c1 3 2 3 3 4-1-6 3-7 5-14Zm0 12c0 3-3 4-3 6 0 1 1 2 3 2 4 0 5-5 0-8Z"/>',
    Grass: '<path fill="currentColor" d="M20 4C9 3 3 7 3 13c0 2 1 3 3 4l-2 4 2 1c2-6 5-10 10-14-3 4-5 7-6 10 7 1 11-5 10-14Z"/>',
    Water: '<path fill="currentColor" d="M12 2C8 8 4 11 4 15a8 8 0 0 0 16 0c0-4-4-7-8-13Zm-5 13c0 3 2 5 5 5-4 1-7-3-5-5Z"/>',
    Earth: '<path fill="currentColor" d="M8 4h4l-3 14H3l2-4Zm6 0h3l4 14H11Z"/><path d="M3 21h18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    Lightning: '<path fill="currentColor" d="M9 2h11l-6 8h6L8 23l3-10H5Z"/>',
    Ice: '<path d="M12 2v20M3.34 7l17.32 10M3.34 17 20.66 7M9 4l3 3 3-3M9 20l3-3 3 3M3.6 10l4-1-1-4M20.4 14l-4 1 1 4M3.6 14l4 1-1 4M20.4 10l-4-1 1-4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"/>',
    Wind: '<path d="M21 10C21 4 12 0 6 6 2 10 3 18 9 20c4 2 10 0 11-4-2 2-5 2-7 1-4-2-4-7 0-8 2-1 4 0 4 2 0 1-1 3-3 3 5 2 8-1 7-4Z" fill="currentColor"/>',
    Dark: '<path d="M17 4a9 9 0 0 1 1 16m-5 1A9 9 0 0 1 6 5m3-2 4-1" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><circle cx="12" cy="12" r="4" fill="currentColor"/>',
    Light: '<path d="m12 1 2.5 4.2L19 3.8l.2 4.8L23 12l-3.8 3.4-.2 4.8-4.5-1.4L12 23l-2.5-4.2L5 20.2l-.2-4.8L1 12l3.8-3.4L5 3.8l4.5 1.4Z" fill="currentColor"/><circle cx="12" cy="12" r="4.5" fill="var(--icon-cutout, #f5a524)"/>',
    Hauling: '<path d="M2 8h3l4 9h11l2-7h-9M10 5l8-2 2 6-8 2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="10" cy="21" r="1.7" fill="currentColor"/><circle cx="19" cy="21" r="1.7" fill="currentColor"/>',
    Artisanship: '<path d="m9 15 10-12m-4 12L5 3" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><circle cx="6" cy="18" r="3" fill="none" stroke="currentColor" stroke-width="2.3"/><circle cx="18" cy="18" r="3" fill="none" stroke="currentColor" stroke-width="2.3"/>',
    Leisure: '<path fill="currentColor" d="M12 11C7 9 7 4 11 3c3 0 3 4 2 7 3-4 8-4 9 0 0 3-4 3-7 3 4 3 4 8 0 9-3 0-3-4-3-7-3 4-8 4-9 0-1-3 4-4 9-4Z"/>',
    Perfumery: '<path fill="currentColor" d="M7 2h10v4h-3v3c3 0 5 2 5 5v8H5v-8c0-3 2-5 5-5V6H7Zm5 11a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z"/>',
};

export function abilityGlyph(name) {
    return Object.hasOwn(shapes, name) ? shapes[name] : '';
}

const elements = {
    Fire: 'Fire', Grass: 'Grass', Water: 'Water', Earth: 'Earth', Lightning: 'Electric',
    Ice: 'Ice', Wind: 'Wind', Dark: 'Dark', Light: 'Light',
};
const jobs = { Hauling: 'Transport', Artisanship: 'Cropping', Leisure: 'Play', Perfumery: 'Incense_Making' };

export function gameAbilityIcon(name) {
    const texture = Object.hasOwn(elements, name) ? `UI_Popup_icon_${elements[name]}`
        : Object.hasOwn(jobs, name) ? `UI_Img_Ability_${jobs[name]}` : '';
    return texture ? `https://cdn.beskor.net/aniimo/icons/${texture}.webp?v=72` : '';
}
