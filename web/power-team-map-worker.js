import {reusePowerTeamLayout} from './power-team-layout.js';
import {haulingWorkload} from './hauling.js';
import {analyzePowerNetworks, optimizePowerNetworks} from './power-islands.js';
import {packMappedTeam, addHarvestHelpers, mappedTeamScore} from './mapped-power-team.js';
import {improvesMeasuredTeam} from './power-team-search.js';
import {fastLayoutSeed} from './fast-layout.js';

self.onmessage = ({data}) => {
    try {
        const {baseLayout, candidates, cells, poleLimit, haulingBound, recipes, facilities, limit} = data;
        let best=data.baselineScore, winner=null;
        const wiredByCount=new Map();
        for (const {index, plan, pieces, jobs} of candidates) {
            let layout=reusePowerTeamLayout(baseLayout,pieces,cells,poleLimit);
            const wired=wiredByCount.get(plan.power_generators);
            if (!layout && wired) layout=reusePowerTeamLayout(wired,pieces,cells,poleLimit);
            if (!layout && !baseLayout.groups) {
                const seed=fastLayoutSeed({pieces,cells,storageCount:baseLayout.storages.length,poleLimit});
                if (!seed.unplaced.length) layout=optimizePowerNetworks(seed,cells,poleLimit);
            }
            if (!layout || layout.unplaced.length) continue;
            const grid=analyzePowerNetworks(layout).power;
            if (grid.disconnected || grid.generators!==plan.power_generators) continue;
            wiredByCount.set(plan.power_generators,layout);
            const hauling=haulingWorkload(layout,plan.coin_items,haulingBound,recipes,facilities,true,4);
            const team=packMappedTeam(plan,jobs,layout,hauling,hauling.busy,recipes);
            const lower=mappedTeamScore(team,grid,limit);
            if (!lower || !improvesMeasuredTeam(lower,best)) continue;
            addHarvestHelpers(team,layout,recipes,limit);
            const score=mappedTeamScore(team,grid,limit);
            if (score && improvesMeasuredTeam(score,best)) {
                best=score;
                winner={index,layout,hauling,team,score};
            }
        }
        self.postMessage({winner});
    } catch(error) {
        self.postMessage({error:error.message});
    }
};
