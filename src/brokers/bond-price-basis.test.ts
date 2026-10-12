import { expect, test } from "bun:test";
import type { BrokerAdapter, BrokerPosition } from "../types/broker";
import { createDefaultConfig } from "../types/config";
import { AppPersistence } from "../data/app-persistence";
import { TickerRepository } from "../data/ticker-repository";
import { syncBrokerInstance } from "./sync-broker-instance";
import { getPortfolioPositionMetrics } from "../portfolio/position-metrics";
import { hydrateTickerMetadata } from "../tickers/metadata";

test("bond basis survives import and SQLite; resync replaces declarations without inferring legacy units",async()=>{
  const db=new AppPersistence(":memory:"); const tickerRepository=new TickerRepository(db.tickers);
  const instance={id:"controlled",brokerType:"controlled",label:"Controlled",enabled:true,config:{}};
  let position:BrokerPosition={ticker:"CONTROLLED",exchange:"",shares:1000,avgCost:87.742,currency:"USD",assetCategory:"BOND",markPrice:86.359375,multiplier:1,marketValue:863.59,unrealizedPnl:-13.83};
  const adapter:BrokerAdapter={id:"controlled",name:"Controlled",configSchema:[],validate:async()=>true,importPositions:async()=>[position]};
  const config={...createDefaultConfig("/unused-bond-basis"),brokerInstances:[instance]};
  try {
    for(const basis of [undefined,"percent-of-par",undefined,"per-unit"] as const) {
      position={...position,priceBasis:basis};
      await syncBrokerInstance({config,instanceId:instance.id,brokers:new Map([[adapter.id,adapter]]),tickerRepository});
      const r=(await tickerRepository.loadTicker("CONTROLLED"))!;
      const persisted=JSON.parse(JSON.stringify(r));
      expect(persisted.metadata.positions[0]).toMatchObject({shares:1000,avgCost:87.742,markPrice:86.359375,multiplier:1});
      expect(persisted.metadata.positions[0].priceBasis).toBe(basis);
      const metrics=getPortfolioPositionMetrics(r,undefined,"USD");
      if(basis===undefined)expect(metrics.totalCost).toBeNaN();
      else expect(metrics.totalCost).toBeCloseTo(basis==="percent-of-par"?877.42:87742,8);
      expect(metrics.brokerMktValue).toBe(863.59);expect(metrics.brokerPnl).toBe(-13.83);
    }
    const stored=(await tickerRepository.loadTicker("CONTROLLED"))!;
    for(const invalid of [null,"", "unknown", 0]) {
      const hydrated=hydrateTickerMetadata({...stored.metadata,positions:[{...stored.metadata.positions[0],priceBasis:invalid}]});
      expect(hydrated.positions[0]!.priceBasis).toBeUndefined();
    }
  } finally {db.close();}
});
