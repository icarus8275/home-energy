import React, { useMemo, useRef, useState, useEffect } from "react";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, PieChart, Pie, Cell } from "recharts";

// US Home Energy Calculator — Alpha++ (Systems, DHW, Prices, Recs)
// Single-file React app for classroom use. Hidden advanced drivers (solar, infiltration, emission
// factors) are still modeled with defaults, but not exposed in the UI. Tooltips help students.

// ----------------------------- Types --------------------------------------

type FoundationType = "Slab" | "Crawlspace" | "Basement (full)" | "Basement (partial)";

type HeatingKind =
  | "Central gas furnace"
  | "Room (through-the-wall) gas furnace"
  | "Gas boiler"
  | "Propane (LPG) central furnace"
  | "Propane (LPG) wall furnace"
  | "Propane (LPG) boiler"
  | "Oil furnace"
  | "Oil boiler"
  | "Electric furnace"
  | "Electric heat pump"
  | "Electric baseboard heater"
  | "Ground coupled heat pump"
  | "Minisplit (ductless) heat pump"
  | "Electric boiler"
  | "Wood stove"
  | "Pellet stove";

interface HeatingSystem {
  kind: HeatingKind;
  AFUE?: number; // for combustion furnaces/boilers (0–1)
  COP?: number; // for heat pumps (heating)
  eff_wood?: number; // fraction for wood/pellet devices (0–1)
}

type CoolingKind =
  | "Central air conditioner"
  | "Room air conditioner"
  | "Electric heat pump"
  | "Minisplit (ductless) heat pump"
  | "Ground coupled heat pump"
  | "Direct evaporative cooling"
  | "None";

interface CoolingSystem {
  kind: CoolingKind;
  SEER?: number; // Btu/Wh equivalent (treat EER ~ SEER for simplicity)
}

type DHWKind =
  | "Electric Storage"
  | "Natural Gas Storage"
  | "Propane (LPG) Storage"
  | "Oil Storage"
  | "Electric Instantaneous"
  | "Gas Instantaneous"
  | "Propane Instantaneous"
  | "Oil Instantaneous"
  | "Electric Heat Pump";

interface DHWSystem {
  kind: DHWKind;
  UEF?: number; // storage/tankless efficiency proxy
  COP?: number; // for HPWH
  setpoint_F: number;
  inlet_F: number;
  gal_per_person_per_day: number;
  days_per_year: number;
}

// Core input structure
interface Inputs {
  // 1) Home basics
  zip: string;
  state: string;
  floorArea_ft2: number; // conditioned floor area
  stories: number;
  ceilingHeight_ft: number; // average ceiling height
  yearBuilt: number;
  foundation: FoundationType;
  occupants: number;

  // 2) Envelope (areas are exposed/conditioned envelope, ft²)
  wallArea_ft2: number; // above-grade wall area (exclude windows/doors)
  wall_R: number; // R-value
  roofArea_ft2: number; // roof/ceiling area exposed to ambient
  roof_R: number;
  floorAreaOverUncond_ft2: number; // floor over unconditioned/exterior (garage/crawl/basement)
  floor_R: number;
  doorArea_ft2: number;
  door_U: number;

  // Windows (summed by orientation) + U and SHGC
  window_N_ft2: number;
  window_S_ft2: number;
  window_E_ft2: number;
  window_W_ft2: number;
  window_U: number; // Btu/hr·ft²·°F
  window_SHGC: number; // used in solar model

  // 2b) Solar gains — simple annual model (hidden in UI)
  incidentSolar_kBtu_ft2yr_N: number;
  incidentSolar_kBtu_ft2yr_S: number;
  incidentSolar_kBtu_ft2yr_E: number;
  incidentSolar_kBtu_ft2yr_W: number;
  shadingFactor: number; // 0–1
  solarToHeating_frac: number; // 0–1
  solarToCooling_frac: number; // 0–1

  // 3) Infiltration/ventilation (hidden in UI)
  ach50?: number;
  nFactor?: number; // LBL conversion to ACHnat; typical 0.07–0.10
  infiltrationCategory: "Tight" | "Average" | "Leaky";

  // 4) Systems (visible)
  heating: HeatingSystem;
  cooling: CoolingSystem;
  dhw: DHWSystem;

  // 5) Climate (visible)
  HDD65: number;
  CDD65: number;

  // 6) Emission factors (hidden in UI)
  emission_kg_per_kWh: number;
  emission_kg_per_therm: number;
  emission_kg_per_gal_propane: number;
  emission_kg_per_gal_oil: number;
  emission_kg_per_cord_wood: number;
  emission_kg_per_ton_pellets: number;

  // 7) Energy prices (visible)
  price_per_kWh: number;
  price_per_therm: number;
  price_per_gal_propane: number;
  price_per_gal_oil: number;
  price_per_cord_wood: number;
  price_per_ton_pellets: number;
}

// --------------------------- Utilities ------------------------------------

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const num = (x: any, fallback = 0) => (isFinite(+x) ? +x : fallback);
const isMissing = (x: any) => !isFinite(+x) || +x <= 0;

// Units/constants
const BTU_PER_KWH = 3412; // Btu/kWh
const BTU_PER_THERM = 100000; // Btu/therm
const BTU_PER_GAL_PROPANE = 91500; // approx
const BTU_PER_GAL_OIL = 138500; // No.2 heating oil
const MMBTU_PER_CORD_WOOD = 20; // rough average
const BTU_PER_TON_PELLETS = 16.5e6; // rough average
const AIR_HEAT_CAPACITY = 1.08; // Btu/(hr·CFM·°F) — sensible

// ------------------------- Default Inputs ----------------------------------

const defaultInputs: Inputs = {
  zip: "",
  state: "",
  floorArea_ft2: 1800,
  stories: 2,
  ceilingHeight_ft: 8,
  yearBuilt: 1995,
  foundation: "Basement (partial)",
  occupants: 3,

  wallArea_ft2: 0, // allow empty → estimated
  wall_R: 0,
  roofArea_ft2: 0,
  roof_R: 0,
  floorAreaOverUncond_ft2: 0,
  floor_R: 0,
  doorArea_ft2: 0,
  door_U: 0,

  window_N_ft2: 0,
  window_S_ft2: 0,
  window_E_ft2: 0,
  window_W_ft2: 0,
  window_U: 0,
  window_SHGC: 0,

  // Placeholder vertical insolation (kBtu/ft²·yr)
  incidentSolar_kBtu_ft2yr_N: 35,
  incidentSolar_kBtu_ft2yr_S: 140,
  incidentSolar_kBtu_ft2yr_E: 90,
  incidentSolar_kBtu_ft2yr_W: 90,
  shadingFactor: 1.0,
  solarToHeating_frac: 0.55,
  solarToCooling_frac: 0.45,

  ach50: undefined,
  nFactor: 0.07,
  infiltrationCategory: "Average",

  heating: { kind: "Central gas furnace", AFUE: 0.92 },
  cooling: { kind: "Central air conditioner", SEER: 15 },
  dhw: { kind: "Electric Storage", UEF: 0.92, setpoint_F: 120, inlet_F: 55, gal_per_person_per_day: 20, days_per_year: 365 },

  HDD65: 5000,
  CDD65: 1000,

  emission_kg_per_kWh: 0.39,
  emission_kg_per_therm: 5.3,
  emission_kg_per_gal_propane: 5.74,
  emission_kg_per_gal_oil: 10.16,
  emission_kg_per_cord_wood: 0,
  emission_kg_per_ton_pellets: 0,

  price_per_kWh: 0.15,
  price_per_therm: 1.20,
  price_per_gal_propane: 2.75,
  price_per_gal_oil: 4.00,
  price_per_cord_wood: 300,
  price_per_ton_pellets: 300,
};

// ---------------------- Smart fallbacks / estimation -----------------------

function typicalByEra(yearBuilt: number) {
  const y = yearBuilt || 1995;
  if (y < 1980) return { wall_R: 9, roof_R: 19, floor_R: 11, window_U: 0.65, ACHnat: 0.7 };
  if (y < 2000) return { wall_R: 13, roof_R: 30, floor_R: 13, window_U: 0.55, ACHnat: 0.5 };
  if (y < 2016) return { wall_R: 19, roof_R: 38, floor_R: 19, window_U: 0.35, ACHnat: 0.4 };
  return { wall_R: 21, roof_R: 49, floor_R: 30, window_U: 0.28, ACHnat: 0.3 };
}

function estimateGeometry(inp: Inputs) {
  const stories = Math.max(inp.stories || 1, 1);
  const h = inp.ceilingHeight_ft || 8;
  const Aflr = Math.max(inp.floorArea_ft2 || 1000, 100);
  const side = Math.sqrt(Aflr / stories); // square footprint
  const perimeter = 4 * side;
  const grossWall = perimeter * h * stories; // ft²

  const doorA = isMissing(inp.doorArea_ft2) ? 40 : inp.doorArea_ft2;
  const winAInput = (inp.window_N_ft2 || 0) + (inp.window_S_ft2 || 0) + (inp.window_E_ft2 || 0) + (inp.window_W_ft2 || 0);

  let windowA = winAInput;
  if (isMissing(winAInput)) windowA = 0.15 * grossWall; // assume 15% WWR

  // If wall area missing, approximate net opaque wall as gross - openings (min 70% of gross)
  const defaultWall = Math.max(grossWall - (doorA + windowA), 0.7 * grossWall);

  const roofA = isMissing(inp.roofArea_ft2) ? Aflr / stories : inp.roofArea_ft2; // top story
  const floorOverUncond = isMissing(inp.floorAreaOverUncond_ft2) ? 0 : inp.floorAreaOverUncond_ft2;

  // Distribute windows if missing
  let wN = inp.window_N_ft2, wS = inp.window_S_ft2, wE = inp.window_E_ft2, wW = inp.window_W_ft2;
  if (isMissing(wN + wS + wE + wW)) {
    wS = 0.30 * windowA; wN = 0.25 * windowA; wE = 0.225 * windowA; wW = 0.225 * windowA;
  }

  return {
    wallArea_ft2: isMissing(inp.wallArea_ft2) ? defaultWall : inp.wallArea_ft2,
    roofArea_ft2: roofA,
    floorAreaOverUncond_ft2: floorOverUncond,
    doorArea_ft2: doorA,
    window_N_ft2: wN,
    window_S_ft2: wS,
    window_E_ft2: wE,
    window_W_ft2: wW,
    grossWall,
  };
}

function withFallbacks(inp: Inputs): Inputs {
  const era = typicalByEra(inp.yearBuilt);
  const geo = estimateGeometry(inp);

  return {
    ...inp,
    wall_R: isMissing(inp.wall_R) ? era.wall_R : inp.wall_R,
    roof_R: isMissing(inp.roof_R) ? era.roof_R : inp.roof_R,
    floor_R: isMissing(inp.floor_R) ? era.floor_R : inp.floor_R,
    window_U: isMissing(inp.window_U) ? era.window_U : inp.window_U,
    window_SHGC: isMissing(inp.window_SHGC) ? 0.30 : inp.window_SHGC,

    wallArea_ft2: geo.wallArea_ft2,
    roofArea_ft2: geo.roofArea_ft2,
    floorAreaOverUncond_ft2: geo.floorAreaOverUncond_ft2,
    doorArea_ft2: geo.doorArea_ft2,
    window_N_ft2: geo.window_N_ft2,
    window_S_ft2: geo.window_S_ft2,
    window_E_ft2: geo.window_E_ft2,
    window_W_ft2: geo.window_W_ft2,

    nFactor: isMissing(inp.nFactor) ? 0.07 : inp.nFactor,

    HDD65: isMissing(inp.HDD65) ? 5000 : inp.HDD65,
    CDD65: isMissing(inp.CDD65) ? 1000 : inp.CDD65,

    heating: defaultHeatingIfMissing(inp.heating),
    cooling: defaultCoolingIfMissing(inp.cooling),
    dhw: defaultDHWIfMissing(inp.dhw, inp.occupants),
  };
}

function defaultHeatingIfMissing(h: HeatingSystem | undefined): HeatingSystem {
  const kind = h?.kind || "Central gas furnace";
  const base: HeatingSystem = { kind };
  const mapDefaults: Record<HeatingKind, Partial<HeatingSystem>> = {
    "Central gas furnace": { AFUE: 0.92 },
    "Room (through-the-wall) gas furnace": { AFUE: 0.82 },
    "Gas boiler": { AFUE: 0.86 },
    "Propane (LPG) central furnace": { AFUE: 0.90 },
    "Propane (LPG) wall furnace": { AFUE: 0.80 },
    "Propane (LPG) boiler": { AFUE: 0.86 },
    "Oil furnace": { AFUE: 0.83 },
    "Oil boiler": { AFUE: 0.85 },
    "Electric furnace": {},
    "Electric heat pump": { COP: 2.8 },
    "Electric baseboard heater": {},
    "Ground coupled heat pump": { COP: 3.5 },
    "Minisplit (ductless) heat pump": { COP: 3.2 },
    "Electric boiler": {},
    "Wood stove": { eff_wood: 0.70 },
    "Pellet stove": { eff_wood: 0.78 },
  };
  const d = mapDefaults[kind];
  return { ...base, ...d, ...h };
}

function defaultCoolingIfMissing(c: CoolingSystem | undefined): CoolingSystem {
  const kind = c?.kind || "Central air conditioner";
  const map: Record<CoolingKind, number | undefined> = {
    "Central air conditioner": 15,
    "Room air conditioner": 12,
    "Electric heat pump": 16,
    "Minisplit (ductless) heat pump": 20,
    "Ground coupled heat pump": 22,
    "Direct evaporative cooling": 25,
    "None": undefined,
  };
  const SEER = c?.SEER ?? map[kind];
  return { kind, SEER };
}

function defaultDHWIfMissing(d: DHWSystem | undefined, occupants: number): DHWSystem {
  const dd = d || ({ kind: "Electric Storage" } as DHWSystem);
  const base: DHWSystem = {
    kind: dd.kind,
    UEF: dd.UEF,
    COP: dd.COP,
    setpoint_F: dd.setpoint_F ?? 120,
    inlet_F: dd.inlet_F ?? 55,
    gal_per_person_per_day: dd.gal_per_person_per_day ?? 20,
    days_per_year: dd.days_per_year ?? 365,
  };
  switch (base.kind) {
    case "Electric Storage": base.UEF = base.UEF ?? 0.92; break;
    case "Natural Gas Storage": base.UEF = base.UEF ?? 0.65; break;
    case "Propane (LPG) Storage": base.UEF = base.UEF ?? 0.65; break;
    case "Oil Storage": base.UEF = base.UEF ?? 0.60; break;
    case "Electric Instantaneous": base.UEF = base.UEF ?? 0.98; break;
    case "Gas Instantaneous": base.UEF = base.UEF ?? 0.82; break;
    case "Propane Instantaneous": base.UEF = base.UEF ?? 0.82; break;
    case "Oil Instantaneous": base.UEF = base.UEF ?? 0.78; break;
    case "Electric Heat Pump": base.COP = base.COP ?? 2.5; break;
  }
  return base;
}

// --------------------------- Calculations ----------------------------------

function uFromR(R: number): number {
  if (!isFinite(R) || R <= 0) return 0;
  return 1 / R;
}

function uaEnvelope(inp: Inputs): number {
  const U_wall = uFromR(inp.wall_R);
  const U_roof = uFromR(inp.roof_R);
  const U_floor = uFromR(inp.floor_R);
  const A_window = inp.window_N_ft2 + inp.window_S_ft2 + inp.window_E_ft2 + inp.window_W_ft2;

  const UA =
    U_wall * inp.wallArea_ft2 +
    U_roof * inp.roofArea_ft2 +
    U_floor * inp.floorAreaOverUncond_ft2 +
    inp.door_U * Math.max(inp.doorArea_ft2, 0) +
    inp.window_U * A_window;

  return Math.max(UA, 0);
}

function houseVolume_ft3(inp: Inputs): number {
  return Math.max(inp.floorArea_ft2, 100) * Math.max(inp.ceilingHeight_ft, 8) * Math.max(inp.stories, 1);
}

function estimateACHnat(inp: Inputs): number {
  if (isFinite(inp.ach50 ?? NaN) && inp.ach50! > 0) {
    const nF = clamp(num(inp.nFactor, 0.07), 0.03, 0.2);
    return inp.ach50! * nF;
  }
  switch (inp.infiltrationCategory) {
    case "Tight": return 0.25;
    case "Leaky": return 0.6;
    default: return 0.4;
  }
}

function uaInfiltration(inp: Inputs): number {
  const volume = Math.max(houseVolume_ft3(inp), 1);
  const ACHnat = Math.max(estimateACHnat(inp), 0);
  const CFM = (ACHnat * volume) / 60;
  return AIR_HEAT_CAPACITY * CFM;
}

function baseAnnualHeatingLoad_Btu(inp: Inputs): number {
  const UA = uaEnvelope(inp) + uaInfiltration(inp);
  const Q = inp.HDD65 * 24 * UA;
  return Math.max(Q, 0);
}

function baseAnnualCoolingLoad_Btu(inp: Inputs): number {
  const UA = uaEnvelope(inp) + uaInfiltration(inp);
  const Q = inp.CDD65 * 24 * UA;
  return Math.max(Q, 0);
}

function annualWindowSolarGain_Btu(inp: Inputs) {
  const k = 1000; // kBtu→Btu per ft²·yr
  const A_N = inp.window_N_ft2; const A_S = inp.window_S_ft2; const A_E = inp.window_E_ft2; const A_W = inp.window_W_ft2;
  const I_N = Math.max(inp.incidentSolar_kBtu_ft2yr_N, 0);
  const I_S = Math.max(inp.incidentSolar_kBtu_ft2yr_S, 0);
  const I_E = Math.max(inp.incidentSolar_kBtu_ft2yr_E, 0);
  const I_W = Math.max(inp.incidentSolar_kBtu_ft2yr_W, 0);
  const shading = clamp(num(inp.shadingFactor, 1), 0, 1);
  const SHGC = clamp(num(inp.window_SHGC, 0.3), 0, 1);
  const Q_Btu = SHGC * shading * (A_N * I_N * k + A_S * I_S * k + A_E * I_E * k + A_W * I_W * k);
  return Math.max(Q_Btu, 0);
}

function annualLoadsWithSolar_Btu(inp: Inputs) {
  const baseH = baseAnnualHeatingLoad_Btu(inp);
  const baseC = baseAnnualCoolingLoad_Btu(inp);
  const Qsolar = annualWindowSolarGain_Btu(inp);
  const fH = clamp(num(inp.solarToHeating_frac, 0.55), 0, 1);
  const fC = clamp(num(inp.solarToCooling_frac, 0.45), 0, 1);
  const Qh = Math.max(baseH - fH * Qsolar, 0);
  const Qc = Math.max(baseC + fC * Qsolar, 0);
  return { Qh, Qc, Qsolar, baseH, baseC };
}

// ------------------------- System energy mapping ---------------------------

type FuelBreakdown = {
  elec_kWh: number;
  gas_therms: number;
  propane_gal: number;
  oil_gal: number;
  wood_cords: number;
  pellets_tons: number;
};

const zeroFuel = (): FuelBreakdown => ({ elec_kWh: 0, gas_therms: 0, propane_gal: 0, oil_gal: 0, wood_cords: 0, pellets_tons: 0 });

function addFuel(a: FuelBreakdown, b: FuelBreakdown): FuelBreakdown {
  return {
    elec_kWh: a.elec_kWh + b.elec_kWh,
    gas_therms: a.gas_therms + b.gas_therms,
    propane_gal: a.propane_gal + b.propane_gal,
    oil_gal: a.oil_gal + b.oil_gal,
    wood_cords: a.wood_cords + b.wood_cords,
    pellets_tons: a.pellets_tons + b.pellets_tons,
  };
}

function heatingFuelUse(inp: Inputs, Qh_Btu: number): FuelBreakdown {
  const h = defaultHeatingIfMissing(inp.heating);
  const out = zeroFuel();
  switch (h.kind) {
    case "Central gas furnace":
    case "Room (through-the-wall) gas furnace":
    case "Gas boiler": {
      const AFUE = clamp(num(h.AFUE, 0.85), 0.5, 0.99);
      return { ...out, gas_therms: Qh_Btu / (AFUE * BTU_PER_THERM) };
    }
    case "Propane (LPG) central furnace":
    case "Propane (LPG) wall furnace":
    case "Propane (LPG) boiler": {
      const AFUE = clamp(num(h.AFUE, 0.85), 0.5, 0.99);
      return { ...out, propane_gal: Qh_Btu / (AFUE * BTU_PER_GAL_PROPANE) };
    }
    case "Oil furnace":
    case "Oil boiler": {
      const AFUE = clamp(num(h.AFUE, 0.83), 0.5, 0.99);
      return { ...out, oil_gal: Qh_Btu / (AFUE * BTU_PER_GAL_OIL) };
    }
    case "Electric furnace":
    case "Electric baseboard heater":
    case "Electric boiler": {
      return { ...out, elec_kWh: Qh_Btu / BTU_PER_KWH };
    }
    case "Electric heat pump": {
      const COP = clamp(num(h.COP, 2.8), 0.5, 6);
      return { ...out, elec_kWh: Qh_Btu / (COP * BTU_PER_KWH) };
    }
    case "Minisplit (ductless) heat pump": {
      const COP = clamp(num(h.COP, 3.2), 0.5, 6);
      return { ...out, elec_kWh: Qh_Btu / (COP * BTU_PER_KWH) };
    }
    case "Ground coupled heat pump": {
      const COP = clamp(num(h.COP, 3.5), 0.5, 8);
      return { ...out, elec_kWh: Qh_Btu / (COP * BTU_PER_KWH) };
    }
    case "Wood stove": {
      const eff = clamp(num(h.eff_wood, 0.70), 0.2, 0.9);
      return { ...out, wood_cords: Qh_Btu / (eff * MMBTU_PER_CORD_WOOD * 1e6) };
    }
    case "Pellet stove": {
      const eff = clamp(num(h.eff_wood, 0.78), 0.2, 0.95);
      return { ...out, pellets_tons: Qh_Btu / (eff * BTU_PER_TON_PELLETS) };
    }
    default:
      return out;
  }
}

function coolingElecUse(inp: Inputs, Qc_Btu: number): FuelBreakdown {
  const c = defaultCoolingIfMissing(inp.cooling);
  const out = zeroFuel();
  if (c.kind === "None") return out;
  const SEER = clamp(num(c.SEER, 14), 8, 40);
  const kWh = (Qc_Btu / SEER) / 1000; // Wh→kWh
  return { ...out, elec_kWh: kWh };
}

function dhwFuelUse(inp: Inputs): FuelBreakdown {
  const d = defaultDHWIfMissing(inp.dhw, inp.occupants);
  const out = zeroFuel();
  const dailyGal = Math.max(inp.occupants || 1, 1) * Math.max(d.gal_per_person_per_day || 20, 1);
  const deltaT = Math.max(d.setpoint_F - d.inlet_F, 10);
  const Btu = 8.34 * dailyGal * deltaT * Math.max(d.days_per_year || 365, 1);

  switch (d.kind) {
    case "Electric Storage": {
      const UEF = clamp(num(d.UEF, 0.92), 0.3, 1.2);
      const kWh = Btu / (UEF * BTU_PER_KWH);
      return { ...out, elec_kWh: kWh };
    }
    case "Electric Instantaneous": {
      const UEF = clamp(num(d.UEF, 0.98), 0.3, 1.2);
      const kWh = Btu / (UEF * BTU_PER_KWH);
      return { ...out, elec_kWh: kWh };
    }
    case "Electric Heat Pump": {
      const COP = clamp(num(d.COP, 2.5), 1, 5);
      const kWh = Btu / (COP * BTU_PER_KWH);
      return { ...out, elec_kWh: kWh };
    }
    case "Natural Gas Storage": {
      const UEF = clamp(num(d.UEF, 0.65), 0.3, 1.2);
      const therms = Btu / (UEF * BTU_PER_THERM);
      return { ...out, gas_therms: therms };
    }
    case "Gas Instantaneous": {
      const UEF = clamp(num(d.UEF, 0.82), 0.3, 1.2);
      const therms = Btu / (UEF * BTU_PER_THERM);
      return { ...out, gas_therms: therms };
    }
    case "Propane (LPG) Storage": {
      const UEF = clamp(num(d.UEF, 0.65), 0.3, 1.2);
      const gal = Btu / (UEF * BTU_PER_GAL_PROPANE);
      return { ...out, propane_gal: gal };
    }
    case "Propane Instantaneous": {
      const UEF = clamp(num(d.UEF, 0.82), 0.3, 1.2);
      const gal = Btu / (UEF * BTU_PER_GAL_PROPANE);
      return { ...out, propane_gal: gal };
    }
    case "Oil Storage": {
      const UEF = clamp(num(d.UEF, 0.60), 0.3, 1.2);
      const gal = Btu / (UEF * BTU_PER_GAL_OIL);
      return { ...out, oil_gal: gal };
    }
    case "Oil Instantaneous": {
      const UEF = clamp(num(d.UEF, 0.78), 0.3, 1.2);
      const gal = Btu / (UEF * BTU_PER_GAL_OIL);
      return { ...out, oil_gal: gal };
    }
    default:
      return out;
  }
}

function sumFuel(...parts: FuelBreakdown[]): FuelBreakdown {
  return parts.reduce(addFuel, zeroFuel());
}

function emissionsCO2(inp: Inputs, fuels: FuelBreakdown) {
  const kgCO2 =
    fuels.elec_kWh * inp.emission_kg_per_kWh +
    fuels.gas_therms * inp.emission_kg_per_therm +
    fuels.propane_gal * inp.emission_kg_per_gal_propane +
    fuels.oil_gal * inp.emission_kg_per_gal_oil +
    fuels.wood_cords * inp.emission_kg_per_cord_wood +
    fuels.pellets_tons * inp.emission_kg_per_ton_pellets;
  return {
    kgCO2,
    byFuel: {
      Electricity: fuels.elec_kWh * inp.emission_kg_per_kWh,
      "Natural Gas": fuels.gas_therms * inp.emission_kg_per_therm,
      Propane: fuels.propane_gal * inp.emission_kg_per_gal_propane,
      Oil: fuels.oil_gal * inp.emission_kg_per_gal_oil,
      Wood: fuels.wood_cords * inp.emission_kg_per_cord_wood,
      Pellets: fuels.pellets_tons * inp.emission_kg_per_ton_pellets,
    },
  };
}

// --------------------------- Cost calculations ----------------------------

function fuelCostUSD(inp: Inputs, f: FuelBreakdown) {
  const cost =
    f.elec_kWh * inp.price_per_kWh +
    f.gas_therms * inp.price_per_therm +
    f.propane_gal * inp.price_per_gal_propane +
    f.oil_gal * inp.price_per_gal_oil +
    f.wood_cords * inp.price_per_cord_wood +
    f.pellets_tons * inp.price_per_ton_pellets;
  return cost;
}

// === Recommendation engine ===

type RecType = "Envelope" | "System" | "Windows" | "DHW" | "Behavior";

interface Recommendation {
  id: string;
  type: RecType;
  title: string;
  explanation: string;
  savings: { fuel: FuelBreakdown; dollars: number; kgCO2: number; Qh_save?: number; Qc_save?: number };
}

function subtractFuel(a: FuelBreakdown, b: FuelBreakdown): FuelBreakdown {
  return {
    elec_kWh: Math.max(a.elec_kWh - b.elec_kWh, 0),
    gas_therms: Math.max(a.gas_therms - b.gas_therms, 0),
    propane_gal: Math.max(a.propane_gal - b.propane_gal, 0),
    oil_gal: Math.max(a.oil_gal - b.oil_gal, 0),
    wood_cords: Math.max(a.wood_cords - b.wood_cords, 0),
    pellets_tons: Math.max(a.pellets_tons - b.pellets_tons, 0),
  };
}

function scaleFuel(a: FuelBreakdown, k: number): FuelBreakdown {
  return {
    elec_kWh: a.elec_kWh * k,
    gas_therms: a.gas_therms * k,
    propane_gal: a.propane_gal * k,
    oil_gal: a.oil_gal * k,
    wood_cords: a.wood_cords * k,
    pellets_tons: a.pellets_tons * k,
  };
}

const uaForACH = (inp: Inputs, ach: number): number => {
  const volume = Math.max(houseVolume_ft3(inp), 1);
  const CFM = (ach * volume) / 60;
  return AIR_HEAT_CAPACITY * CFM;
};

function dhwDeliveredBtu(inp: Inputs): number {
  const d = defaultDHWIfMissing(inp.dhw, inp.occupants);
  const dailyGal = Math.max(inp.occupants || 1, 1) * Math.max(d.gal_per_person_per_day || 20, 1);
  const deltaT = Math.max(d.setpoint_F - d.inlet_F, 10);
  return 8.34 * dailyGal * deltaT * Math.max(d.days_per_year || 365, 1);
}

function buildRecommendations(
  inp: Inputs,
  loads: { Qh: number; Qc: number; Qsolar: number; baseH: number; baseC: number },
  heatingFuel: FuelBreakdown,
  coolingFuel: FuelBreakdown,
  dhwFuel: FuelBreakdown
): Recommendation[] {
  const recs: Recommendation[] = [];
  const windowAreaTotal = inp.window_N_ft2 + inp.window_S_ft2 + inp.window_E_ft2 + inp.window_W_ft2;

  // 1) Attic insulation
  const targetRoofR = inp.HDD65 >= 6000 ? 60 : 49;
  if (isFinite(inp.roof_R) && inp.roof_R > 0 && inp.roof_R < targetRoofR - 1 && inp.roofArea_ft2 > 0) {
    const dU = 1 / inp.roof_R - 1 / targetRoofR;
    if (dU > 0) {
      const Qh_save = inp.HDD65 * 24 * dU * inp.roofArea_ft2;
      const Qc_save = inp.CDD65 * 24 * dU * inp.roofArea_ft2;
      const fuelSaved = sumFuel(heatingFuelUse(inp, Qh_save), coolingElecUse(inp, Qc_save));
      recs.push({
        id: "attic-insulation",
        type: "Envelope",
        title: `Add attic insulation to R${targetRoofR}`,
        explanation: `Current roof R≈${Math.round(inp.roof_R)}; raising to R${targetRoofR} cuts conduction.`,
        savings: { fuel: fuelSaved, dollars: fuelCostUSD(inp, fuelSaved), kgCO2: emissionsCO2(inp, fuelSaved).kgCO2, Qh_save, Qc_save },
      });
    }
  }

  // 2) Air sealing
  const ACHnat_now = estimateACHnat(inp);
  if (ACHnat_now > 0.35) {
    const UA_now = uaInfiltration(inp);
    const ACHnat_target = 0.25;
    const UA_tgt = uaForACH(inp, ACHnat_target);
    const dUA = Math.max(UA_now - UA_tgt, 0);
    const Qh_save = inp.HDD65 * 24 * dUA;
    const Qc_save = inp.CDD65 * 24 * dUA;
    const fuelSaved = sumFuel(heatingFuelUse(inp, Qh_save), coolingElecUse(inp, Qc_save));
    recs.push({
      id: "air-sealing",
      type: "Envelope",
      title: "Air sealing & weatherstrip (blower-door guided)",
      explanation: `Leakage looks ${ACHnat_now >= 0.6 ? "leaky" : "average"} (ACHnat≈${ACHnat_now.toFixed(2)}). Target ≈0.25 to cut infiltration.`,
      savings: { fuel: fuelSaved, dollars: fuelCostUSD(inp, fuelSaved), kgCO2: emissionsCO2(inp, fuelSaved).kgCO2, Qh_save, Qc_save },
    });
  }

  // 3) Window U upgrade
  if (windowAreaTotal > 80 && inp.window_U > 0.35) {
    const U_tgt = 0.30;
    const dU = inp.window_U - U_tgt;
    const Qh_save = inp.HDD65 * 24 * dU * windowAreaTotal;
    const Qc_save = inp.CDD65 * 24 * dU * windowAreaTotal;
    const fuelSaved = sumFuel(heatingFuelUse(inp, Qh_save), coolingElecUse(inp, Qc_save));
    recs.push({
      id: "window-upgrade",
      type: "Windows",
      title: "Upgrade to low-U windows",
      explanation: `Avg U≈${inp.window_U.toFixed(2)} → U≈${U_tgt} lowers conductive losses.`,
      savings: { fuel: fuelSaved, dollars: fuelCostUSD(inp, fuelSaved), kgCO2: emissionsCO2(inp, fuelSaved).kgCO2, Qh_save, Qc_save },
    });
  }

  // 4) Solar control
  const solarCoolingAdd = clamp(num(inp.solarToCooling_frac, 0.45), 0, 1) * annualWindowSolarGain_Btu(inp);
  if (solarCoolingAdd > 0.05 * loads.Qc && (inp.shadingFactor > 0.6 || inp.window_SHGC > 0.30)) {
    const Qc_save = 0.3 * solarCoolingAdd;
    const fuelSaved = coolingElecUse(inp, Qc_save);
    recs.push({
      id: "solar-control",
      type: "Windows",
      title: "Add west/south shading or low-SHGC glazing",
      explanation: "Exterior shading/films cut solar-driven cooling.",
      savings: { fuel: fuelSaved, dollars: fuelCostUSD(inp, fuelSaved), kgCO2: emissionsCO2(inp, fuelSaved).kgCO2, Qc_save },
    });
  }

  // 5) Heating → heat pump
  const isHP = ["Electric heat pump", "Minisplit (ductless) heat pump", "Ground coupled heat pump"].includes(inp.heating.kind);
  if (!isHP && loads.Qh > 0) {
    const COP_tgt = 3.2;
    const newHP = { elec_kWh: loads.Qh / (COP_tgt * BTU_PER_KWH), gas_therms: 0, propane_gal: 0, oil_gal: 0, wood_cords: 0, pellets_tons: 0 } as FuelBreakdown;
    const fuelSaved = subtractFuel(heatingFuel, newHP);
    const dollars = fuelCostUSD(inp, fuelSaved);
    const kg = emissionsCO2(inp, fuelSaved).kgCO2;
    if (dollars > 10 || kg > 25) {
      recs.push({
        id: "heat-pump-upgrade",
        type: "System",
        title: "Replace main heater with a heat pump (ductless minisplit)",
        explanation: `COP≈${COP_tgt} often cuts 50–70% vs. resistance/older fossil systems.`,
        savings: { fuel: fuelSaved, dollars, kgCO2: kg, Qh_save: loads.Qh },
      });
    }
  }

  // 6) Cooling upgrade (SEER)
  if (inp.cooling.kind !== "None" && num(inp.cooling.SEER, 15) < 18 && loads.Qc > 0) {
    const SEER_new = 20;
    const kWh_old = (loads.Qc / Math.max(num(inp.cooling.SEER, 15), 8)) / 1000;
    const kWh_new = (loads.Qc / SEER_new) / 1000;
    const fuelSaved = { ...zeroFuel(), elec_kWh: Math.max(kWh_old - kWh_new, 0) };
    recs.push({
      id: "cooling-upgrade",
      type: "System",
      title: `Upgrade cooling to SEER ${SEER_new}+ (e.g., ductless)`,
      explanation: `Your current SEER≈${Math.round(num(inp.cooling.SEER, 15))}. High-SEER uses fewer kWh for same cooling.`,
      savings: { fuel: fuelSaved, dollars: fuelCostUSD(inp, fuelSaved), kgCO2: emissionsCO2(inp, fuelSaved).kgCO2, Qc_save: loads.Qc },
    });
  }

  // 7) DHW → heat pump water heater
  if (inp.dhw.kind !== "Electric Heat Pump") {
    const Btu_del = dhwDeliveredBtu(inp);
    const kWh_new = Btu_del / (2.5 * BTU_PER_KWH);
    const newFuel = { ...zeroFuel(), elec_kWh: kWh_new };
    const fuelSaved = subtractFuel(dhwFuel, newFuel);
    recs.push({
      id: "hpwh",
      type: "DHW",
      title: "Install a heat pump water heater",
      explanation: "HPWH uses ~60–70% less electricity than standard electric; often lower CO₂.",
      savings: { fuel: fuelSaved, dollars: fuelCostUSD(inp, fuelSaved), kgCO2: emissionsCO2(inp, fuelSaved).kgCO2 },
    });
  }

  // 8) DHW behavior (−20%)
  if (dhwFuel.elec_kWh + dhwFuel.gas_therms + dhwFuel.propane_gal + dhwFuel.oil_gal > 0) {
    const fuelSaved = scaleFuel(dhwFuel, 0.20);
    recs.push({
      id: "dhw-behavior",
      type: "Behavior",
      title: "Low-flow showerheads & 20% shorter showers",
      explanation: "Immediate, low-cost savings on hot water.",
      savings: { fuel: fuelSaved, dollars: fuelCostUSD(inp, fuelSaved), kgCO2: emissionsCO2(inp, fuelSaved).kgCO2 },
    });
  }

  // 9) Thermostat setback (~6%)
  if (loads.Qh > 0) {
    const Qh_save = 0.06 * loads.Qh;
    const fuelSaved = heatingFuelUse(inp, Qh_save);
    recs.push({
      id: "thermostat-setback",
      type: "Behavior",
      title: "3°F heating setback overnight / when away",
      explanation: "Smart thermostat scheduling ~2% per °F setback.",
      savings: { fuel: fuelSaved, dollars: fuelCostUSD(inp, fuelSaved), kgCO2: emissionsCO2(inp, fuelSaved).kgCO2, Qh_save },
    });
  }

  return recs.filter(r => r.savings.dollars >= 15 || r.savings.kgCO2 >= 25);
}

function formatFuelBreakdown(f: FuelBreakdown): string {
  const parts: string[] = [];
  if (f.elec_kWh > 0.05) parts.push(`${f.elec_kWh.toFixed(0)} kWh`);
  if (f.gas_therms > 0.05) parts.push(`${f.gas_therms.toFixed(1)} therms`);
  if (f.propane_gal > 0.05) parts.push(`${f.propane_gal.toFixed(0)} gal propane`);
  if (f.oil_gal > 0.05) parts.push(`${f.oil_gal.toFixed(0)} gal oil`);
  if (f.wood_cords > 0.01) parts.push(`${f.wood_cords.toFixed(2)} cords wood`);
  if (f.pellets_tons > 0.01) parts.push(`${f.pellets_tons.toFixed(2)} tons pellets`);
  return parts.join(" • ");
}

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mb-6 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">{title}</h2>
        {right}
      </div>
      <div className="grid gap-3">{children}</div>
    </div>
  );
}

function Row({ children, cols = 3 }: { children: React.ReactNode; cols?: 1 | 2 | 3 | 4 }) {
  const map: Record<number, string> = { 1: "sm:grid-cols-1", 2: "sm:grid-cols-2", 3: "sm:grid-cols-3", 4: "sm:grid-cols-4" };
  return <div className={`grid grid-cols-1 gap-3 ${map[cols]}`}>{children}</div>;
}

function HelpTip({ text }: { text: string }) {
  return (
    <span className="group relative ml-2 inline-flex items-center align-middle">
      <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border bg-white text-xs leading-none text-gray-600">?</span>
      <span className="pointer-events-none absolute left-6 top-1 z-20 hidden w-72 rounded-md border bg-white p-3 text-xs text-gray-700 shadow-lg group-hover:block">{text}</span>
    </span>
  );
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-center text-sm font-medium text-gray-800">
        {label}
        {hint ? <HelpTip text={hint} /> : null}
      </span>
      {children}
    </label>
  );
}

function InputNumber({ value, onChange, step = 1, min, max, placeholder }:
  { value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; placeholder?: string }) {
  const [s, setS] = useState<string>(Number.isFinite(value) ? String(value) : "");
  useEffect(() => { setS(Number.isFinite(value) ? String(value) : ""); }, [value]);
  return (
    <input
      type="number"
      className="w-full rounded-xl border px-3 py-2 outline-none focus:ring"
      value={s}
      step={step}
      min={min}
      max={max}
      placeholder={placeholder}
      onChange={(e) => setS(e.target.value)}
      onBlur={() => onChange(num(s, NaN))}
    />
  );
}

function InputText({ value, onChange, placeholder }:
  { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input
      type="text"
      className="w-full rounded-xl border px-3 py-2 outline-none focus:ring"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function Select<T extends string>({ value, onChange, options }:
  { value: T; onChange: (v: T) => void; options: { label: string; value: T }[] }) {
  return (
    <select
      className="w-full rounded-xl border bg-white px-3 py-2 outline-none focus:ring"
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// ------------------------------- App ---------------------------------------

export default function HomeEnergyCalculator() {
  const [inp, setInp] = useState<Inputs>(defaultInputs);
  const [help, setHelp] = useState<boolean>(true);
  const fileRef = useRef<HTMLInputElement>(null);

  const eff = useMemo(() => withFallbacks(inp), [inp]);

  const UA_env = useMemo(() => uaEnvelope(eff), [eff]);
  const UA_inf = useMemo(() => uaInfiltration(eff), [eff]);

  const loads = useMemo(() => annualLoadsWithSolar_Btu(eff), [eff]);

  const heatingFuel = useMemo(() => heatingFuelUse(eff, loads.Qh), [loads.Qh, eff.heating]);
  const coolingFuel = useMemo(() => coolingElecUse(eff, loads.Qc), [loads.Qc, eff.cooling]);
  const dhwFuel    = useMemo(() => dhwFuelUse(eff), [eff.dhw, eff.occupants]);

  const fuelsAll = useMemo(() => sumFuel(heatingFuel, coolingFuel, dhwFuel), [heatingFuel, coolingFuel, dhwFuel]);
  const emi = useMemo(() => emissionsCO2(eff, fuelsAll), [eff, fuelsAll]);

  const costHeating = useMemo(() => fuelCostUSD(eff, heatingFuel), [heatingFuel, eff.price_per_kWh, eff.price_per_therm, eff.price_per_gal_propane, eff.price_per_gal_oil, eff.price_per_cord_wood, eff.price_per_ton_pellets]);
  const costCooling = useMemo(() => fuelCostUSD(eff, coolingFuel), [coolingFuel, eff.price_per_kWh, eff.price_per_therm, eff.price_per_gal_propane, eff.price_per_gal_oil, eff.price_per_cord_wood, eff.price_per_ton_pellets]);
  const costDHW     = useMemo(() => fuelCostUSD(eff, dhwFuel),    [dhwFuel,    eff.price_per_kWh, eff.price_per_therm, eff.price_per_gal_propane, eff.price_per_gal_oil, eff.price_per_cord_wood, eff.price_per_ton_pellets]);
  const costTotal = costHeating + costCooling + costDHW;

  // Recommendations
  const recs = useMemo(() => buildRecommendations(eff, loads, heatingFuel, coolingFuel, dhwFuel), [eff, loads, heatingFuel, coolingFuel, dhwFuel]);
  const [recSort, setRecSort] = useState<'cost' | 'co2'>('cost');
  const recsSorted = useMemo(() => {
    const arr = [...recs];
    return arr.sort((a, b) =>
      recSort === 'co2'
        ? b.savings.kgCO2 - a.savings.kgCO2
        : b.savings.dollars - a.savings.dollars
    );
  }, [recs, recSort]);
  const recsShown = useMemo(() => recsSorted.slice(0, 6), [recsSorted]);

  // Save/Load
  const saveJSON = () => {
    const blob = new Blob([JSON.stringify(inp, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `home-energy-inputs.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const loadJSON = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        const safeKeys = new Set(Object.keys(defaultInputs));
        const safe: any = {};
        const ignored: string[] = [];
        for (const k of Object.keys(data)) {
          if (safeKeys.has(k)) safe[k] = (data as any)[k];
          else ignored.push(k);
        }
        setInp((prev) => ({ ...prev, ...safe }));
        if (ignored.length) alert(`Ignored ${ignored.length} unrecognized field(s): ${ignored.slice(0,5).join(', ')}${ignored.length>5?' …':''}`);
      } catch (e) {
        alert("Failed to parse JSON: please check the file.");
      }
    };
    reader.readAsText(file);
  };

  const windowAreaTotal = eff.window_N_ft2 + eff.window_S_ft2 + eff.window_E_ft2 + eff.window_W_ft2;
  const totalUA = UA_env + UA_inf;
  const quickEstimate = () => setInp((prev) => withFallbacks(prev));

  // --- Charts data ---
  const chartLoads = [
    { name: "Heating", Base: loads.baseH / 1_000_000, WithSolar: loads.Qh / 1_000_000 },
    { name: "Cooling", Base: loads.baseC / 1_000_000, WithSolar: loads.Qc / 1_000_000 },
  ];

  const pieData = Object.entries(emi.byFuel)
    .filter(([_, v]) => (v ?? 0) > 0.01)
    .map(([k, v]) => ({ name: k, value: v }));

  const PIE_COLORS = ["#8884d8", "#82ca9d", "#ffc658", "#8dd1e1", "#a4de6c", "#d0ed57"]; // simple palette

  const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });
  const fmt$ = (n: number) => n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });

  // --- Tiny unit tests (run once) ---
  useEffect(() => {
    try {
      console.assert(Math.abs(uFromR(10) - 0.1) < 1e-9, "uFromR failed");
      const vol = houseVolume_ft3({ ...(defaultInputs as any), floorArea_ft2: 1000, ceilingHeight_ft: 8, stories: 1 });
      console.assert(vol === 8000, "houseVolume_ft3 failed");
      const elecHeat = heatingFuelUse({ ...(defaultInputs as any), heating: { kind: 'Electric furnace' } }, 3_412_000);
      console.assert(Math.round(elecHeat.elec_kWh) === 1000, "electric resistance mapping failed");
      const cool = coolingElecUse({ ...(defaultInputs as any), cooling: { kind: 'Central air conditioner', SEER: 10 } }, 10_000_000);
      console.assert(Math.round(cool.elec_kWh) === 1000, "cooling SEER mapping failed");
      const solarZero = annualWindowSolarGain_Btu({ ...(defaultInputs as any), window_N_ft2:0, window_S_ft2:0, window_E_ft2:0, window_W_ft2:0 } as any);
      console.assert(Math.abs(solarZero) < 1e-6, "solar gain with zero area should be 0");
      const achAvg = estimateACHnat({ ...(defaultInputs as any), ach50: undefined, infiltrationCategory: 'Average' } as any);
      console.assert(Math.abs(achAvg - 0.4) < 1e-6, "ACHnat Average fallback failed");
      const emi0 = emissionsCO2(defaultInputs as any, zeroFuel());
      console.assert(Math.abs(emi0.kgCO2) < 1e-9, "emissions for zero fuel should be 0");
      const cost0 = fuelCostUSD(defaultInputs as any, zeroFuel());
      console.assert(Math.abs(cost0) < 1e-9, "cost for zero fuel should be 0");
      console.assert(typicalByEra(1975).wall_R === 9 && typicalByEra(1990).roof_R === 30 && typicalByEra(2010).window_U === 0.35 && typicalByEra(2022).floor_R === 30, "typicalByEra mapping failed");
      const gasTherms = heatingFuelUse({ ...(defaultInputs as any), heating: { kind: 'Central gas furnace', AFUE: 0.9 } }, 1_000_000).gas_therms;
      console.assert(Math.abs(gasTherms - (1_000_000 / (0.9 * 100000))) < 1e-6, "gas AFUE mapping failed");
      const dhwTherms = dhwFuelUse({ ...(defaultInputs as any), occupants: 1, dhw: { kind: 'Natural Gas Storage', UEF: 0.6, setpoint_F: 120, inlet_F: 60, gal_per_person_per_day: 10, days_per_year: 365 } as any }).gas_therms;
      const expectedDHW_Btu = 8.34 * 10 * (120 - 60) * 365;
      console.assert(Math.abs(dhwTherms - (expectedDHW_Btu / (0.6 * 100000))) < 1e-6, "DHW NG storage mapping failed");
      console.info("✅ Quick tests passed");
    } catch (e) {
      console.warn("Unit test exception", e);
    }
  }, []);

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">US Home Energy Calculator — Alpha</h1>
          <p className="text-sm text-gray-600">Conduction + infiltration + solar + systems & hot water. Student-friendly with hints.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button className="rounded-xl border px-3 py-2" onClick={() => setHelp((v) => !v)}>{help ? "Hide help" : "Show help"}</button>
          <button className="rounded-xl border px-3 py-2" onClick={quickEstimate}>Quick estimate (autofill missing)</button>
          <button className="rounded-xl border px-3 py-2" onClick={saveJSON}>Save Inputs (JSON)</button>
          <input ref={fileRef} type="file" accept="application/json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) loadJSON(f); }} />
          <button className="rounded-xl border px-3 py-2" onClick={() => fileRef.current?.click()}>Load</button>
        </div>
      </header>

      {/* 0) How to use */}
      {help && (
        <Section title="0) How to use">
          <div className="text-sm text-gray-700 leading-relaxed">
            <ul className="list-disc pl-5 space-y-1">
              <li>Don’t know a value? Leave it blank — we’ll estimate from year and size.</li>
              <li>Hover the <b>?</b> icons for quick tips per field.</li>
              <li>Click <b>Quick estimate</b> to auto-fill reasonable defaults.</li>
              <li>Results update live: loads, emissions, costs, and recommendations.</li>
            </ul>
          </div>
        </Section>
      )}

      {/* 1) Home basics */}
      <Section title="1) Home basics">
        <Row cols={3}>
          <Field label="ZIP (optional)"><InputText value={inp.zip} onChange={(v) => setInp({ ...inp, zip: v })} placeholder="e.g., 94709" /></Field>
          <Field label="State (optional)"><InputText value={inp.state} onChange={(v) => setInp({ ...inp, state: v })} placeholder="e.g., CA" /></Field>
          <Field label="Year built" hint={"Used to auto-estimate typical insulation & window performance by era.\nPre-1980: wall R≈9, roof R≈19, floor R≈11, window U≈0.65.\n1980–1999: R13/R30/R13, U≈0.55.\n2000–2015: R19/R38/R19, U≈0.35.\n2016+: R21/R49/R30, U≈0.28."}><InputNumber value={inp.yearBuilt} onChange={(v) => setInp({ ...inp, yearBuilt: v })} /></Field>
        </Row>
        <Row cols={3}>
          <Field label="Floor area, ft²" hint="Conditioned floor area only (heated/cooled). Used to estimate wall/roof areas and the house volume (affects infiltration)."><InputNumber value={inp.floorArea_ft2} onChange={(v) => setInp({ ...inp, floorArea_ft2: v })} /></Field>
          <Field label="Stories" hint="Number of conditioned stories; increases wall area and reduces roof area per story."><InputNumber value={inp.stories} onChange={(v) => setInp({ ...inp, stories: v })} /></Field>
          <Field label="Avg ceiling height, ft" hint="Average height across conditioned spaces. Contributes to volume → infiltration losses."><InputNumber value={inp.ceilingHeight_ft} onChange={(v) => setInp({ ...inp, ceilingHeight_ft: v })} /></Field>
        </Row>
        <Row cols={3}>
          <Field label="Foundation" hint="For context. Floor heat loss uses 'floor over unconditioned' area below if provided."><Select value={inp.foundation} onChange={(v) => setInp({ ...inp, foundation: v })} options={[
            { label: 'Slab', value: 'Slab' },
            { label: 'Crawlspace', value: 'Crawlspace' },
            { label: 'Basement (full)', value: 'Basement (full)' },
            { label: 'Basement (partial)', value: 'Basement (partial)' },
          ]} /></Field>
          <Field label="Occupants" hint="Used to estimate hot water use (gal/person/day)."><InputNumber value={inp.occupants} onChange={(v) => setInp({ ...inp, occupants: v })} /></Field>
        </Row>
      </Section>

      {/* 2) Envelope & Windows */}
      <Section title="2) Envelope & Windows">
        <Row cols={3}>
          <Field label="Wall area, ft²" hint="Above-grade opaque wall area excluding windows/doors. If unknown, we estimate from footprint & height minus openings."><InputNumber value={inp.wallArea_ft2} onChange={(v) => setInp({ ...inp, wallArea_ft2: v })} /></Field>
          <Field label="Wall R-value" hint="Higher R = better. Typical by era (see Year built). If unknown, leave blank and we’ll auto-fill."><InputNumber value={inp.wall_R} onChange={(v) => setInp({ ...inp, wall_R: v })} /></Field>
          <Field label="Door area, ft²" hint="Sum of exterior door areas. If unknown, ~40 ft² typical for two doors."><InputNumber value={inp.doorArea_ft2} onChange={(v) => setInp({ ...inp, doorArea_ft2: v })} /></Field>
        </Row>
        <Row cols={3}>
          <Field label="Roof area, ft²" hint="Top-floor ceiling/roof area exposed to ambient. Approximate with upper-story footprint."><InputNumber value={inp.roofArea_ft2} onChange={(v) => setInp({ ...inp, roofArea_ft2: v })} /></Field>
          <Field label="Roof R-value" hint="Attic/roof insulation. Cold climates target R49–60. If unknown, inferred by era."><InputNumber value={inp.roof_R} onChange={(v) => setInp({ ...inp, roof_R: v })} /></Field>
          <Field label="Door U-factor" hint="If unknown, 0.3–0.5 typical for insulated exterior doors (lower is better)."><InputNumber value={inp.door_U} onChange={(v) => setInp({ ...inp, door_U: v })} /></Field>
        </Row>
        <Row cols={4}>
          <Field label="Windows North, ft²" hint="Approximate glass area by orientation. If unknown, leave blank—we’ll assume a distribution."><InputNumber value={inp.window_N_ft2} onChange={(v) => setInp({ ...inp, window_N_ft2: v })} /></Field>
          <Field label="South, ft²" hint="Part of total glazing area; used internally for solar."><InputNumber value={inp.window_S_ft2} onChange={(v) => setInp({ ...inp, window_S_ft2: v })} /></Field>
          <Field label="East, ft²" hint="Part of total glazing area; used internally for solar."><InputNumber value={inp.window_E_ft2} onChange={(v) => setInp({ ...inp, window_E_ft2: v })} /></Field>
          <Field label="West, ft²" hint="Part of total glazing area; used internally for solar."><InputNumber value={inp.window_W_ft2} onChange={(v) => setInp({ ...inp, window_W_ft2: v })} /></Field>
        </Row>
        <Row cols={3}>
          <Field label="Window U-factor" hint="Rate of heat flow (Btu/hr·ft²·°F). Lower = better. Double-pane ~0.30–0.50; modern low-e can be ≤0.28."><InputNumber value={inp.window_U} onChange={(v) => setInp({ ...inp, window_U: v })} step={0.01} /></Field>
          <Field label="Window SHGC" hint="Solar Heat Gain Coefficient (0–1). Lower reduces cooling; higher admits winter sun."><InputNumber value={inp.window_SHGC} onChange={(v) => setInp({ ...inp, window_SHGC: v })} step={0.01} /></Field>
          <Field label="Total windows (auto)" hint="Read-only sum of all orientations."><input disabled className="w-full rounded-xl border bg-gray-50 px-3 py-2" value={Math.round(windowAreaTotal)} /></Field>
        </Row>
      </Section>

      {/* 3) Systems */}
      <Section title="3) Systems (heating, cooling, DHW)">
        <Row cols={3}>
          <Field label="Heating system" hint="Select the primary space-heating system used most of the season.">
            <Select value={inp.heating.kind} onChange={(v) => setInp({ ...inp, heating: { ...inp.heating, kind: v as HeatingKind } })} options={[
              'Central gas furnace','Room (through-the-wall) gas furnace','Gas boiler','Propane (LPG) central furnace','Propane (LPG) wall furnace','Propane (LPG) boiler','Oil furnace','Oil boiler','Electric furnace','Electric heat pump','Electric baseboard heater','Ground coupled heat pump','Minisplit (ductless) heat pump','Electric boiler','Wood stove','Pellet stove'
            ].map(x=>({label:x, value:x as HeatingKind}))} />
          </Field>
          {['Central gas furnace','Room (through-the-wall) gas furnace','Gas boiler','Propane (LPG) central furnace','Propane (LPG) wall furnace','Propane (LPG) boiler','Oil furnace','Oil boiler'].includes(inp.heating.kind) && (
            <Field label="AFUE (0–1)" hint="Annual Fuel Utilization Efficiency (combustion). 0.80–0.95 typical (higher = better).">
              <InputNumber value={inp.heating.AFUE as any} onChange={(v)=>setInp({...inp, heating:{...inp.heating, AFUE: v}})} step={0.01} />
            </Field>
          )}
          {['Electric heat pump','Minisplit (ductless) heat pump','Ground coupled heat pump'].includes(inp.heating.kind) && (
            <Field label="Heating COP" hint="Coefficient of Performance (delivered heat ÷ electric input). 2.5–3.5 typical; >3 for minisplits/ground-source.">
              <InputNumber value={inp.heating.COP as any} onChange={(v)=>setInp({...inp, heating:{...inp.heating, COP: v}})} step={0.1} />
            </Field>
          )}
          {['Wood stove','Pellet stove'].includes(inp.heating.kind) && (
            <Field label="Appliance efficiency (0–1)" hint="Wood ~0.6–0.75; pellet ~0.75–0.85.">
              <InputNumber value={inp.heating.eff_wood as any} onChange={(v)=>setInp({...inp, heating:{...inp.heating, eff_wood: v}})} step={0.01} />
            </Field>
          )}
        </Row>

        <Row cols={3}>
          <Field label="Cooling system" hint="Select the main cooling type. Choose 'None' if not present.">
            <Select value={inp.cooling.kind} onChange={(v) => setInp({ ...inp, cooling: { ...inp.cooling, kind: v as CoolingKind } })} options={[
              'Central air conditioner','Room air conditioner','Electric heat pump','Minisplit (ductless) heat pump','Ground coupled heat pump','Direct evaporative cooling','None'
            ].map(x=>({label:x, value:x as CoolingKind}))} />
          </Field>
          {inp.cooling.kind !== 'None' && (
            <Field label="SEER" hint="Seasonal Energy Efficiency Ratio (Btu/Wh). Higher = better."><InputNumber value={inp.cooling.SEER as any} onChange={(v)=>setInp({...inp, cooling:{...inp.cooling, SEER: v}})} step={0.5} /></Field>
          )}
        </Row>

        <Row cols={3}>
          <Field label="Hot water type" hint="Domestic hot water (DHW) system type. Influences fuel and efficiency.">
            <Select value={inp.dhw.kind} onChange={(v)=>setInp({...inp, dhw:{...inp.dhw, kind: v as DHWKind}})} options={[
              'Electric Storage','Natural Gas Storage','Propane (LPG) Storage','Oil Storage','Electric Instantaneous','Gas Instantaneous','Propane Instantaneous','Oil Instantaneous','Electric Heat Pump'
            ].map(x=>({label:x, value:x as DHWKind}))} />
          </Field>
          {['Electric Storage','Natural Gas Storage','Propane (LPG) Storage','Oil Storage','Electric Instantaneous','Gas Instantaneous','Propane Instantaneous','Oil Instantaneous'].includes(inp.dhw.kind) && (
            <Field label="UEF" hint="Uniform Energy Factor (overall efficiency). 0.6–0.95 typical; higher is better."><InputNumber value={inp.dhw.UEF as any} onChange={(v)=>setInp({...inp, dhw:{...inp.dhw, UEF: v}})} step={0.01} /></Field>
          )}
          {inp.dhw.kind === 'Electric Heat Pump' && (
            <Field label="COP (HPWH)" hint="Heat pump water heater COP (often 2–3)."><InputNumber value={inp.dhw.COP as any} onChange={(v)=>setInp({...inp, dhw:{...inp.dhw, COP: v}})} step={0.1} /></Field>
          )}
        </Row>
        <Row cols={4}>
          <Field label="Setpoint °F" hint="Hot water tank setpoint (120°F common)."><InputNumber value={inp.dhw.setpoint_F} onChange={(v)=>setInp({...inp, dhw:{...inp.dhw, setpoint_F: v}})} /></Field>
          <Field label="Inlet °F" hint="Approximate cold water temperature entering the home."><InputNumber value={inp.dhw.inlet_F} onChange={(v)=>setInp({...inp, dhw:{...inp.dhw, inlet_F: v}})} /></Field>
          <Field label="Gal/person/day" hint="Daily hot water draw per person (15–25 typical)."><InputNumber value={inp.dhw.gal_per_person_per_day} onChange={(v)=>setInp({...inp, dhw:{...inp.dhw, gal_per_person_per_day: v}})} /></Field>
          <Field label="Days/year" hint="Usually 365."><InputNumber value={inp.dhw.days_per_year} onChange={(v)=>setInp({...inp, dhw:{...inp.dhw, days_per_year: v}})} /></Field>
        </Row>
      </Section>

      {/* 4) Climate */}
      <Section title="4) Climate (base 65°F)">
        <Row cols={3}>
          <Field label="Heating Degree Days (HDD65)" hint="Sum of (65°F − daily mean) when positive."><InputNumber value={inp.HDD65} onChange={(v)=>setInp({...inp, HDD65: v})} /></Field>
          <Field label="Cooling Degree Days (CDD65)" hint="Sum of (daily mean − 65°F) when positive."><InputNumber value={inp.CDD65} onChange={(v)=>setInp({...inp, CDD65: v})} /></Field>
        </Row>
      </Section>

      {/* 5) Energy prices */}
      <Section title="5) Energy prices (edit to your local rates)">
        <Row cols={3}>
          <Field label="Electricity ($/kWh)" hint="Enter your utility rate (or keep default)."><InputNumber value={inp.price_per_kWh} onChange={(v)=>setInp({...inp, price_per_kWh: v})} step={0.01} /></Field>
          <Field label="Natural gas ($/therm)" hint="Enter your gas rate (or keep default)."><InputNumber value={inp.price_per_therm} onChange={(v)=>setInp({...inp, price_per_therm: v})} step={0.01} /></Field>
          <Field label="Propane ($/gal)" hint="Enter your supplier price (or default)."><InputNumber value={inp.price_per_gal_propane} onChange={(v)=>setInp({...inp, price_per_gal_propane: v})} step={0.01} /></Field>
        </Row>
        <Row cols={3}>
          <Field label="Oil ($/gal)" hint="Enter supplier price (or default)."><InputNumber value={inp.price_per_gal_oil} onChange={(v)=>setInp({...inp, price_per_gal_oil: v})} step={0.01} /></Field>
          <Field label="Cord wood ($/cord)" hint="Full cord price (or default)."><InputNumber value={inp.price_per_cord_wood} onChange={(v)=>setInp({...inp, price_per_cord_wood: v})} /></Field>
          <Field label="Pellets ($/ton)" hint="Pellet price (or default)."><InputNumber value={inp.price_per_ton_pellets} onChange={(v)=>setInp({...inp, price_per_ton_pellets: v})} /></Field>
        </Row>
      </Section>

      {/* 6) Results & graphs */}
      <Section title="6) Results & graphs" right={<div className="text-sm text-gray-600">All values update live</div>}>
        <Row cols={3}>
          <div className="rounded-2xl border p-4">
            <div className="text-sm text-gray-600">UA breakdown (Btu/hr·°F)</div>
            <div className="text-2xl font-semibold">{fmt(UA_env + UA_inf)}</div>
            <div className="text-xs text-gray-600">Envelope UA (approx): {fmt(UA_env)} — lower is better</div>
            {totalUA > 0 ? <div className="text-xs text-gray-600">Air leakage ≈ {Math.round((UA_inf/totalUA)*100)}% of total UA</div> : null}
          </div>
          <div className="rounded-2xl border p-4">
            <div className="text-sm text-gray-600">Emissions</div>
            <div className="text-2xl font-semibold">{fmt(emi.kgCO2)} kg CO₂e/yr</div>
          </div>
          <div className="rounded-2xl border p-4">
            <div className="text-sm text-gray-600">Annual energy cost</div>
            <div className="text-2xl font-semibold">{fmt$(costTotal)}</div>
            <div className="text-xs text-gray-600">Heating {fmt$(costHeating)} • Cooling {fmt$(costCooling)} • DHW {fmt$(costDHW)}</div>
          </div>
        </Row>

        <Row cols={2}>
          <div className="h-64 rounded-2xl border p-3">
            <div className="mb-1 text-sm text-gray-600">Annual loads (million Btu)</div>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartLoads}>
                <XAxis dataKey="name" />
                <YAxis />
                <Tooltip />
                <Legend />
                <Bar dataKey="Base" stackId="a" name="Base (no solar)" fill="#60a5fa" />
                <Bar dataKey="WithSolar" stackId="a" name="With solar" fill="#f59e0b" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="h-64 rounded-2xl border p-3">
            <div className="mb-1 text-sm text-gray-600">Emissions by fuel (kg CO₂e)</div>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={pieData} dataKey="value" nameKey="name" label>
                  {pieData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </Row>
      </Section>

      {/* 7) Recommendations */}
      <Section
        title="7) Recommendations"
        right={
          <div className="flex items-center gap-2 text-sm">
            <span className="text-gray-500">Sort by</span>
            <select className="rounded-xl border bg-white px-2 py-1" value={recSort} onChange={(e) => setRecSort(e.target.value as 'cost' | 'co2')}>
              <option value="cost">Annual $ savings</option>
              <option value="co2">Annual CO₂ savings</option>
            </select>
          </div>
        }
      >
        {recsShown.length === 0 ? (
          <div className="rounded-2xl border border-dashed p-4 text-sm text-gray-600">No high-impact actions detected yet. Try entering more details (e.g., window U, roof R, leakage) or adjust prices.</div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {recsShown.map((r) => (
              <div key={r.id} className="rounded-2xl border p-4">
                <div className="mb-1 flex items-center justify-between">
                  <div className="text-base font-semibold">{r.title}</div>
                  <span className="rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-700">{r.type}</span>
                </div>
                <div className="mb-3 text-sm text-gray-600">{r.explanation}</div>
                <div className="grid grid-cols-3 gap-2 text-sm">
                  <div className="rounded-xl bg-gray-50 p-3">Annual $ Savings<br/><b>{fmt$(r.savings.dollars)}</b></div>
                  <div className="rounded-xl bg-gray-50 p-3">Annual CO₂ Savings<br/><b>{fmt(r.savings.kgCO2)}</b> kg</div>
                  <div className="rounded-xl bg-gray-50 p-3">Fuel Avoided<br/><b>{formatFuelBreakdown(r.savings.fuel) || '—'}</b></div>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="mt-2 text-xs text-gray-500">Tip: change energy prices above to see savings update live. Use Quick estimate if many fields are blank.</div>
      </Section>

      <footer className="mt-8 flex items-center justify-between text-xs text-gray-500">
        <div>Alpha build for classroom use. Equations are simplified but consistent.</div>
        <a className="underline" href="#top">Back to top</a>
      </footer>
    </div>
  );
}
