import { useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { RefreshCw, Plus, Settings2 } from "lucide-react";

// --- Helpers ---
const LBF_PER_N = 1 / 4.4482216152605; // convert N -> lbf
const KTKV = 9.5492965964254; // Kt [Nm/A] = KTKV / Kv[rpm/V]

function number(val: number | string) {
  const n = typeof val === "string" ? parseFloat(val) : val;
  return isFinite(n) ? n : 0;
}

export default function App() {
  // Motor constant entry mode
  const [constMode, setConstMode] = useState<"KT" | "KV">("KT");
  const [KtState, setKtState] = useState(0.272); // Nm/A (editable when mode = KT)
  const [KvState, setKvState] = useState(35); // rpm/V (editable when mode = KV)

  // Derived Kt used everywhere
  const Kt = useMemo(() => (constMode === "KT" ? KtState : KTKV / Math.max(1e-9, KvState)), [constMode, KtState, KvState]);
  const Kv = useMemo(() => (constMode === "KV" ? KvState : KTKV / Math.max(1e-9, KtState)), [constMode, KvState, KtState]);

  // Motoring vs regenerating
  const [mode, setMode] = useState<"CONC" | "ECC">("CONC"); // CONC = concentric (motoring), ECC = eccentric (regenerating)

  // Motor & electrical defaults (editable)
  const [Rll, setRll] = useState(0.164); // line-to-line ohms
  const [Lll_uH, setLll_uH] = useState(235); // line-to-line inductance in microhenry
  const [winding, setWinding] = useState<"DELTA" | "WYE">("DELTA");
  const [copperTempC, setCopperTempC] = useState(25); // °C

  // Voltage supply & modulation
  const [Vbus, setVbus] = useState(48); // DC bus voltage
  const [util, setUtil] = useState(0.95); // modulation utilization (SVPWM ~0.907 for phase; we expose a simple factor)

  // Current / torque caps
  const [Imax, setImax] = useState(72); // A (phase RMS)
  const TmMax = useMemo(() => Kt * Imax, [Kt, Imax]);

  // Field-weakening (negative d-axis current limit)
  const [idFWmax, setIdFWmax] = useState(0); // A, maximum |i_d| allowed for field-weakening (0 = off)

  // Mechanics / transmission
  const [gearRatio, setGearRatio] = useState(10); // motor : output
  const [gearEff, setGearEff] = useState(0.9); // 0..1
  const [drumRadius, setDrumRadius] = useState(0.05); // meters (effective cable radius)

  // Chart domain
  const [maxSpeed, setMaxSpeed] = useState(3); // m/s (rep speed)
  const [steps, setSteps] = useState(60);

  // Power supplies selection
  const presets = [450, 1000, 1500, 2000, 3000, 5000];
  const [selected, setSelected] = useState<number[]>([3000]);
  const [customW, setCustomW] = useState<string>("");

  // Phase values from line-to-line and temperature
  const RphaseBase = useMemo(() => (winding === "WYE" ? Rll / 2 : 1.5 * Rll), [Rll, winding]);
  const LphaseBase = useMemo(() => {
    const Lll = Lll_uH * 1e-6; // H
    return winding === "WYE" ? Lll / 2 : 1.5 * Lll;
  }, [Lll_uH, winding]);

  const Rphase = useMemo(() => {
    // Temperature-adjust copper resistance (approx. 0.0039/°C)
    const alpha = 0.0039;
    return RphaseBase * (1 + alpha * (copperTempC - 25));
  }, [RphaseBase, copperTempC]);

  // Copper-loss coefficient: P_cu = kcu * T_m^2  (motor shaft)
  const kcu = useMemo(() => (3 * Rphase) / (Kt * Kt), [Rphase, Kt]);

  // Max fundamental phase voltage available from DC bus
  // Approx: V_phase_max ≈ (util * Vbus) / sqrt(3)
  const VphaseMax = useMemo(() => (util * Vbus) / Math.sqrt(3), [Vbus, util]);

  const seriesKeys = useMemo(() => selected.map((w) => `${w} W`), [selected]);

  const data = useMemo(() => {
    const arr: Record<string, number>[] = [];
    const step = Math.max(1, steps);
    const N_ID = 40; // grid for id search
    for (let i = 0; i <= step; i++) {
      const v = (maxSpeed * i) / step; // m/s at the handle/cable (output)
      const omega_out = v / Math.max(1e-9, drumRadius); // rad/s at output
      const omega_m = omega_out * gearRatio; // rad/s at motor
      const row: Record<string, number> = { speed: v };

      // Precompute voltage quadratic coefficients that don't depend on id
      const R = Rphase;
      const L = LphaseBase;
      const Ke = Kt; // SI units: Ke = Kt (V/(rad/s))
      const Vmax = VphaseMax;
      const A = R * R + (omega_m * L) * (omega_m * L);
      const Babs = 2 * R * omega_m * Ke; // |B|, sign depends on iq sign

      for (const Pin of selected) {
        let bestTm = 0; // best motor torque magnitude for this speed & supply

        for (let k = 0; k <= N_ID; k++) {
          const id = -idFWmax * (k / N_ID); // 0 to -|idFWmax|

          // Current limit -> max |iq|
          const iqMaxCurrent = Math.sqrt(Math.max(0, Imax * Imax - id * id));

          // Voltage limit -> solve A iq^2 + s*Babs iq + C(id) ≤ 0
          const C = (R * id) * (R * id) + Math.pow(omega_m * (L * id + Ke), 2) - Vmax * Vmax;
          const disc = Babs * Babs - 4 * A * C;
          let iqMaxVoltConc = 0;
          let iqMaxVoltEcc = 0;
          if (disc >= 0) {
            const sqrtD = Math.sqrt(disc);
            // For motoring (iq ≥ 0): use sign +
            iqMaxVoltConc = Math.max(0, (-Babs + sqrtD) / (2 * A));
            // For eccentric (iq ≤ 0): magnitude uses sign - (equivalently flip B)
            iqMaxVoltEcc = Math.max(0, (Babs + sqrtD) / (2 * A));
          }
          const iqMaxVolt = mode === "CONC" ? iqMaxVoltConc : iqMaxVoltEcc;

          // Power limit (motoring only): 3R(I^2) + Kt*omega*|iq| ≤ Pin
          let iqMaxPower = Infinity;
          if (mode === "CONC") {
            const aP = 3 * Rphase;
            const bP = Kt * omega_m;
            const cP = 3 * Rphase * id * id - Pin;
            const Dp = bP * bP - 4 * aP * cP;
            if (Dp >= 0) {
              iqMaxPower = Math.max(0, (-bP + Math.sqrt(Dp)) / (2 * aP));
            } else {
              iqMaxPower = 0; // no feasible motoring at this id/speed under Pin
            }
          }

          const iqMax = Math.min(iqMaxCurrent, iqMaxVolt, iqMaxPower);
          const Tm = Kt * iqMax;
          if (Tm > bestTm) bestTm = Tm;
        }

        // Also cap by the torque/current limit (redundant with current constraint but harmless)
        const TmFinal = Math.min(bestTm, TmMax);
        const Tout = TmFinal * gearRatio * gearEff; // Nm at output (magnitude)
        const F = Tout / Math.max(1e-9, drumRadius); // N
        const lbf = F * LBF_PER_N;
        row[`${Pin} W`] = isFinite(lbf) && lbf > 0 ? lbf : 0;
      }
      arr.push(row);
    }
    return arr;
  }, [selected, maxSpeed, steps, drumRadius, gearRatio, gearEff, Imax, idFWmax, Rphase, LphaseBase, Kt, VphaseMax, TmMax, mode, RphaseBase]);

  const maxY = useMemo(() => {
    let m = 0;
    data.forEach((d) => seriesKeys.forEach((k) => (m = Math.max(m, number(d[k])))));
    return Math.ceil(m / 25) * 25; // round up to nice tick
  }, [data, seriesKeys]);

  function togglePreset(w: number) {
    setSelected((prev) => (prev.includes(w) ? prev.filter((x) => x !== w) : [...prev, w].sort((a, b) => a - b)));
  }
  function addCustom() {
    const v = Math.round(number(customW));
    if (!v) return;
    setSelected((prev) => (prev.includes(v) ? prev : [...prev, v].sort((a, b) => a - b)));
    setCustomW("");
  }
  function resetDefaults() {
    setConstMode("KT");
    setKtState(0.272);
    setKvState(35);
    setMode("CONC");
    setRll(0.164);
    setLll_uH(235);
    setWinding("DELTA");
    setCopperTempC(25);
    setVbus(48);
    setUtil(0.95);
    setImax(72);
    setIdFWmax(0);
    setGearRatio(10);
    setGearEff(0.9);
    setDrumRadius(0.05);
    setMaxSpeed(3);
    setSteps(60);
    setSelected([3000]);
  }

  return (
    <div className="p-6 mx-auto max-w-7xl space-y-6">
      <div className="flex items-center gap-3">
        <Settings2 className="w-6 h-6" />
        <h1 className="text-2xl font-semibold">Power‑Limited Resistance vs Speed Explorer</h1>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Motor & Electrical */}
        <Card className="rounded-2xl">
          <CardHeader>
            <CardTitle>Motor & Electrical</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label>Enter constant by</Label>
              <Select value={constMode} onValueChange={(v: string) => setConstMode(v as any)}>
                <SelectTrigger><SelectValue placeholder="Mode" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="KT">Torque constant (Kt)</SelectItem>
                  <SelectItem value="KV">Speed constant (Kv)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Torque constant Kt (Nm/A)</Label>
              <Input type="number" step="0.001" value={constMode === "KT" ? KtState : Kt} disabled={constMode !== "KT"} onChange={(e: ChangeEvent<HTMLInputElement>) => setKtState(number(e.target.value))} />
            </div>
            <div>
              <Label>Speed constant Kv (rpm/V)</Label>
              <Input type="number" step="0.1" value={constMode === "KV" ? KvState : Kv} disabled={constMode !== "KV"} onChange={(e: ChangeEvent<HTMLInputElement>) => setKvState(number(e.target.value))} />
            </div>
            <div>
              <Label>Line‑to‑Line R (Ω)</Label>
              <Input type="number" step="0.001" value={Rll} onChange={(e: ChangeEvent<HTMLInputElement>) => setRll(number(e.target.value))} />
            </div>
            <div>
              <Label>Line‑to‑Line L (µH)</Label>
              <Input type="number" step="1" value={Lll_uH} onChange={(e: ChangeEvent<HTMLInputElement>) => setLll_uH(number(e.target.value))} />
            </div>
            <div>
              <Label>Winding</Label>
              <Select value={winding} onValueChange={(v: string) => setWinding(v as any)}>
                <SelectTrigger><SelectValue placeholder="Winding" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="DELTA">Delta (Δ)</SelectItem>
                  <SelectItem value="WYE">Wye (Y)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Copper Temp (°C)</Label>
              <Input type="number" step="1" value={copperTempC} onChange={(e: ChangeEvent<HTMLInputElement>) => setCopperTempC(number(e.target.value))} />
            </div>
            <div className="col-span-2 text-sm opacity-80 space-y-1">
              <div>Per‑phase Rφ = <b>{Rphase.toFixed(3)} Ω</b></div>
              <div>Per‑phase Lφ = <b>{LphaseBase.toExponential(3)} H</b></div>
              <div>k₍cu₎ = 3·Rφ/Kt² = <b>{kcu.toFixed(2)} W/Nm²</b> (using Kt = {Kt.toFixed(3)} Nm/A)</div>
            </div>
          </CardContent>
        </Card>

        {/* Voltage, Current, Mode & Field‑Weakening */}
        <Card className="rounded-2xl">
          <CardHeader>
            <CardTitle>Voltage, Current, Mode & Field‑Weakening</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3">
            <div>
              <Label>DC Bus Voltage Vbus (V)</Label>
              <Input type="number" step="0.1" value={Vbus} onChange={(e) => setVbus(number(e.target.value))} />
            </div>
            <div>
              <Label>Utilization (0–1)</Label>
              <Input type="number" step="0.01" value={util} onChange={(e) => setUtil(Math.max(0, Math.min(1, number(e.target.value))))} />
            </div>
            <div>
              <Label>Max Phase Current (A)</Label>
              <Input type="number" step="0.1" value={Imax} onChange={(e) => setImax(number(e.target.value))} />
            </div>
            <div>
              <Label>Max Motor Torque (Nm)</Label>
              <Input type="number" step="0.1" value={Number(Imax * Kt)} onChange={(e) => setImax(number(e.target.value) / Math.max(1e-9, Kt))} />
            </div>
            <div>
              <Label>Field‑Weakening |i_d|max (A)</Label>
              <Input type="number" step="0.1" value={idFWmax} onChange={(e) => setIdFWmax(Math.max(0, number(e.target.value)))} />
            </div>
            <div className="text-sm flex items-end">Phase voltage limit ≈ <b className="ml-1">{VphaseMax.toFixed(2)} V</b></div>
            <div className="col-span-2">
              <Label>Mode</Label>
              <Select value={mode} onValueChange={(v: string) => setMode(v as any)}>
                <SelectTrigger><SelectValue placeholder="Mode" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="CONC">Concentric (motoring)</SelectItem>
                  <SelectItem value="ECC">Eccentric (regenerating)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2 text-sm opacity-80 space-y-1">
              <div>dq model: v_d = R i_d − ω L i_q; v_q = R i_q + ω L i_d + ω K_e. We enforce v_d²+v_q² ≤ V_phase,max², |i_d| ≤ |i_d|_max, and |i| ≤ I_max. Motoring also enforces P_in ≤ P_limit.</div>
              <div>Tip: Increase |i_d|_max for more speed via field‑weakening; torque at high speed drops because i_q shares the current budget.</div>
            </div>
          </CardContent>
        </Card>

        {/* Transmission */}
        <Card className="rounded-2xl">
          <CardHeader>
            <CardTitle>Transmission & Geometry</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3">
            <div>
              <Label>Gear ratio (motor:output)</Label>
              <Input type="number" step="0.1" value={gearRatio} onChange={(e) => setGearRatio(number(e.target.value))} />
            </div>
            <div>
              <Label>Gear efficiency</Label>
              <Input type="number" step="0.01" value={gearEff} onChange={(e) => setGearEff(Math.max(0, Math.min(1, number(e.target.value))))} />
            </div>
            <div>
              <Label>Drum radius (m)</Label>
              <Input type="number" step="0.001" value={drumRadius} onChange={(e) => setDrumRadius(number(e.target.value))} />
            </div>
            <div>
              <Label>Max rep speed (m/s)</Label>
              <Input type="number" step="0.1" value={maxSpeed} onChange={(e) => setMaxSpeed(number(e.target.value))} />
            </div>
            <div>
              <Label>Chart points</Label>
              <Input type="number" step="1" value={steps} onChange={(e) => setSteps(Math.max(10, Math.min(500, number(e.target.value))))} />
            </div>
            <div className="flex items-end justify-end">
              <Button variant="outline" onClick={resetDefaults} className="gap-2"><RefreshCw className="w-4 h-4"/>Reset</Button>
            </div>
          </CardContent>
        </Card>

        {/* Power supplies (selection UI) */}
        <Card className="rounded-2xl">
          <CardHeader>
            <CardTitle>Power Supplies (W)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-3 gap-2">
              {presets.map((w) => (
                <label key={w} className="flex items-center gap-2 rounded-xl border p-2 cursor-pointer hover:bg-accent">
                  <Checkbox checked={selected.includes(w)} onCheckedChange={() => togglePreset(w)} id={`psu-${w}`} />
                  <span>{w}</span>
                </label>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Input placeholder="Custom W" value={customW} onChange={(e) => setCustomW(e.target.value)} type="number" />
              <Button variant="secondary" onClick={addCustom} className="gap-2"><Plus className="w-4 h-4"/>Add</Button>
            </div>
            <div className="text-sm opacity-80">In eccentric mode, curves are identical across supplies (PSU watts do not limit torque with a regen clamp).</div>
          </CardContent>
        </Card>
      </div>

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Resistance (lbf) vs Rep Speed (m/s) — Power, Voltage & Torque Limited</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-[420px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 10, right: 20, left: 10, bottom: 10 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="speed" type="number" name="Rep speed" unit=" m/s" domain={[0, maxSpeed]} tickCount={7} />
                <YAxis type="number" name="Resistance" unit=" lbf" domain={[0, maxY || 'auto']} tickCount={8} />
                <Tooltip formatter={(value: any, name: any) => [Number(value).toFixed(1) + " lbf", name]} labelFormatter={(v: any) => `Speed: ${Number(v).toFixed(2)} m/s`} />
                <Legend />
                {seriesKeys.map((key) => (
                  <Line key={key} type="monotone" dataKey={key} dot={false} strokeWidth={2} isAnimationActive={false} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="text-sm mt-3 opacity-80 space-y-1">
            <div>Electrical input power (motoring): P_in = τ·ω + 3·I_φ²·R_φ with τ = Kt·i_q. In eccentric mode, PSU watts are not constraining (regen clamp assumed).</div>
            <div>Voltage limit (dq): v_d = R i_d − ω L i_q; v_q = R i_q + ω L i_d + ω K_e; enforce v_d²+v_q² ≤ V_phase,max². Allowed torque is the min from voltage, current, torque cap, and (motoring) power limit. Field‑weakening uses negative i_d up to |i_d|_max.</div>
            <div>Conversion: Kt [Nm/A] = {KTKV.toFixed(4)} / Kv [rpm/V].</div>
          </div>
        </CardContent>
      </Card>

      <div className="text-xs opacity-70">
        Notes: Copper (I²R) losses and a dq voltage model with inductance are included. Controller switching and iron losses are ignored and will slightly reduce available force at high speeds. Increase copper temp to see the impact of hot windings. Regen clamp is assumed for eccentric operation. Beware demagnetization limits when using large negative i_d.
      </div>
    </div>
  );
}
