import type { models } from "../db/schema.js";

export function estimateUsageCost(model:typeof models.$inferSelect|undefined,input:number,output:number,cached:number|null) {
  if (!model) return {costUsd:0,costCny:0,pricedCurrency:null};
  const cny=model.pricingCurrency==="CNY";
  const inputRate=cny?model.costInputCnyPerMillion:model.costInputUsdPerMillion;
  const outputRate=cny?model.costOutputCnyPerMillion:model.costOutputUsdPerMillion;
  const hit=cached??0;
  const cost=((input-hit)*inputRate+hit*model.cacheReadPricePer1m+output*outputRate)/1_000_000;
  const priced=inputRate>0 || outputRate>0 || model.cacheReadPricePer1m>0 || model.confirmedFree;
  return {costUsd:cny?0:cost,costCny:cny?cost:0,pricedCurrency:priced?model.pricingCurrency:null};
}

export class OutputTiming {
  private first: number | null = null;
  private last: number | null = null;
  constructor(private readonly started = performance.now()) {}

  delta(text:unknown) {
    if (typeof text!=="string" || !text) return;
    this.last=performance.now();
    this.first??=this.last;
  }
  get ttft() { return this.first===null ? null : Math.round(this.first-this.started); }
  speed(output:number) {
    if (output<=1 || this.first===null || this.last===null || this.last-this.first<1) return null;
    return Math.round((output-1)*100000/(this.last-this.first))/100;
  }
}
