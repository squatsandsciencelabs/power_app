import React, { useMemo, useState } from "react";
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

function number(val: number | string) {
  const n = typeof val === "string" ? parseFloat(val) : val;
  return isFinite(n) ? n : 0;
}

export default function App() {
  // Motor & electrical defaults (from your spec, but editable)
  const [Kt, setKt] = useState(0.272); // Nm/A
  const [Rll, setRll] = useState(0.164); // line-to-line ohms
  const [winding, setWinding] = useState<"DELTA" | "WYE">("DELTA");
  const [copperTempC, setCopperTempC] = useState(25); // °C

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

  const RphaseBase = useMemo(() => (winding === "WYE" ? Rll / 2 : 1.5 * Rll), [Rll, winding]);
  const Rphase = useMemo(() => {
    // Temperature-adjust copper resistance (approx. 0.0039/°C)
    const alpha = 0.0039;
    return RphaseBase * (1 + alpha * (copperTempC - 25));
  }, [RphaseBase, copperTempC]);

  // Copper-loss coefficient: P_cu = kcu * T_m^2  (motor shaft)
  const kcu = useMemo(() => (3 * Rphase) / (Kt * Kt), [Rphase, Kt]);

  const seriesKeys = useMemo(() => selected.map((w) => `${w} W`), [selected]);

  const data = useMemo(() => {
    const arr: Record<string, number>[] = [];
    const step = Math.max(1, steps);
    for (let i = 0; i <= step; i++) {
      const v = (maxSpeed * i) / step; // m/s at the handle/cable (output)
      const omega_out = v / Math.max(1e-9, drumRadius); // rad/s at output
      const omega_m = omega_out * gearRatio; // rad/s at motor
      const row: Record<string, number> = { speed: v };
      for (const Pin of selected) {
        // Solve kcu*T^2 + omega_m*T - Pin = 0  for positive T
        const disc = omega_m * omega_m + 4 * kcu * Pin;
        const Tm = (Math.sqrt(disc) - omega_m) / (2 * kcu); // Nm at motor
        const Tout = Tm * gearRatio * gearEff; // Nm at output
        const F = Tout / Math.max(1e-9, drumRadius); // N
        const lbf = F * LBF_PER_N;
        row[`${Pin} W`] = isFinite(lbf) && lbf > 0 ? lbf : 0;
      }
      arr.push(row);
    }
    return arr;
  }, [selected, maxSpeed, steps, drumRadius, gearRatio, gearEff, kcu]);

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
    setKt(0.272);
    setRll(0.164);
    setWinding("DELTA");
    setCopperTempC(25);
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
            <div>
              <Label>Torque constant Kt (Nm/A)</Label>
              <Input type="number" step="0.001" value={Kt} onChange={(e) => setKt(number(e.target.value))} />
            </div>
            <div>
              <Label>Line‑to‑Line R (Ω)</Label>
              <Input type="number" step="0.001" value={Rll} onChange={(e) => setRll(number(e.target.value))} />
            </div>
            <div>
              <Label>Winding</Label>
              <Select value={winding} onValueChange={(v) => setWinding(v as any)}>
                <SelectTrigger><SelectValue placeholder="Winding" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="DELTA">Delta (Δ)</SelectItem>
                  <SelectItem value="WYE">Wye (Y)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Copper Temp (°C)</Label>
              <Input type="number" step="1" value={copperTempC} onChange={(e) => setCopperTempC(number(e.target.value))} />
            </div>
            <div className="col-span-2 text-sm opacity-80 space-y-1">
              <div>Per‑phase Rφ = <b>{Rphase.toFixed(3)} Ω</b></div>
              <div>k₍cu₎ = 3·Rφ/Kt² = <b>{kcu.toFixed(2)} W/Nm²</b></div>
            </div>
          </CardContent>
        </Card>

        {/* Mechanics */}
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

        {/* Power supplies */}
        <Card className="rounded-2xl">
          <CardHeader>
            <CardTitle>Power Supplies</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-3 gap-2">
              {presets.map((w) => (
                <label key={w} className="flex items-center gap-2 rounded-xl border p-2 cursor-pointer hover:bg-accent">
                  <Checkbox checked={selected.includes(w)} onCheckedChange={() => togglePreset(w)} id={`psu-${w}`} />
                  <span>{w} W</span>
                </label>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Input placeholder="Custom W" value={customW} onChange={(e) => setCustomW(e.target.value)} type="number" />
              <Button variant="secondary" onClick={addCustom} className="gap-2"><Plus className="w-4 h-4"/>Add</Button>
            </div>
            <div className="text-sm opacity-80">Toggle one or more to plot multiple curves.</div>
          </CardContent>
        </Card>
      </div>

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Resistance (lbf) vs Rep Speed (m/s) — Power‑Limited</CardTitle>
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
                {seriesKeys.map((key, idx) => (
                  <Line key={key} type="monotone" dataKey={key} dot={false} strokeWidth={2} isAnimationActive={false} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="text-sm mt-3 opacity-80">
            Model: P_in = τ·ω + 3·I_φ²·R_φ with τ = Kt·I_φ. Using per‑phase resistance R_φ derived from line‑to‑line R and winding type. Output force F = (τ_m·η_g·G)/r, speed v = ω_out·r, with ω_out = ω_m/G.
          </div>
        </CardContent>
      </Card>

      <div className="text-xs opacity-70">
        Notes: This accounts for copper (I²R) losses only. Controller, core, and windage losses are ignored and will slightly reduce available force at high speeds. Increase copper temp to see the impact of hot windings. Ensure regen handling (brake resistor or regen‑capable supply) for eccentric/back‑driven phases.
      </div>
    </div>
  );
}
