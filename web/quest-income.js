// Daily rewards are independent of legacy one-off stock.
export function questIncome(values){
    return Object.fromEntries(['wood_block','mineral_sand'].flatMap(name=>{
        const amount=Number(values?.[name]);
        return Number.isFinite(amount)&&amount>0?[[name,Math.min(1_000_000_000,amount)]]:[];
    }));
}
