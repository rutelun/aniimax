// Occupied quarter tiles, packed into 32-bit rows. The caller keeps its exact
// rectangle intersection test for coordinates that this grid cannot represent.
export function rectangleMask(cells, {removable = false} = {}) {
    if (!cells?.length) return null;
    const left = Math.floor(Math.min(...cells.map(r => r.x)) * 4);
    const top = Math.floor(Math.min(...cells.map(r => r.y)) * 4);
    const width = Math.ceil(Math.max(...cells.map(r => r.x + r.w)) * 4) - left;
    const height = Math.ceil(Math.max(...cells.map(r => r.y + r.h)) * 4) - top;
    if (!(width > 0 && height > 0 && width * height <= 1_000_000)) return null;
    const stride = Math.ceil(width / 32);
    const words = new Uint32Array(stride * height);
    let complete = true;
    let disjoint = true;

    function fitsGrid(r) {
        return Number.isInteger(r.x * 4) && Number.isInteger(r.y * 4)
            && Number.isInteger(r.w * 4) && Number.isInteger(r.h * 4) && r.w > 0 && r.h > 0
            && r.x * 4 >= left && r.y * 4 >= top
            && (r.x + r.w) * 4 <= left + width && (r.y + r.h) * 4 <= top + height;
    }
    function visit(r, operation) {
        const x = r.x * 4 - left, y = r.y * 4 - top;
        const right = x + r.w * 4 - 1, bottom = y + r.h * 4;
        const first = x >>> 5, last = right >>> 5;
        const leftMask = 0xffffffff << (x & 31), rightMask = 0xffffffff >>> (31 - (right & 31));
        for (let word = first; word <= last; word++) {
            const mask = (word === first ? leftMask : 0xffffffff) & (word === last ? rightMask : 0xffffffff);
            for (let row = y; row < bottom; row++) {
                const i = row * stride + word;
                if (operation === 'add') {
                    if (removable && (words[i] & mask)) disjoint = false;
                    words[i] |= mask;
                } else if (operation === 'remove') words[i] &= ~mask;
                else if (words[i] & mask) return true;
            }
        }
        return false;
    }
    return {
        add(r) {
            if (fitsGrid(r)) visit(r, 'add');
            else complete = false;
        },
        remove(r) {
            // Shared tiles have no owner in this bitset. After such a removal,
            // the caller uses its rectangle index for exact overlap checks.
            if (complete && disjoint && removable && fitsGrid(r)) visit(r, 'remove');
            else complete = false;
        },
        overlaps(r) { return complete && fitsGrid(r) ? visit(r, 'query') : undefined; },
    };
}
