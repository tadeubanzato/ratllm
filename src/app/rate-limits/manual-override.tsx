"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function ManualOverride({ profileId, manualRpm, manualTpm }: { profileId: string; manualRpm: number | null; manualTpm: number | null }) {
  const [rpm, setRpm] = useState(manualRpm?.toString() ?? "");
  const [tpm, setTpm] = useState(manualTpm?.toString() ?? "");
  const [saving, setSaving] = useState(false);
  const router = useRouter();

  async function save() {
    setSaving(true);
    try {
      await fetch("/api/rate-limits", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: profileId, manualRpm: rpm ? Number(rpm) : null, manualTpm: tpm ? Number(tpm) : null }),
      });
      router.refresh();
    } finally { setSaving(false); }
  }

  return <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
    <input className="input" style={{ width: 58, height: 26, fontSize: 10.5, padding: "0 6px" }} type="number" min={1} placeholder="RPM" value={rpm} onChange={e => setRpm(e.target.value)}/>
    <input className="input" style={{ width: 58, height: 26, fontSize: 10.5, padding: "0 6px" }} type="number" min={1} placeholder="TPM" value={tpm} onChange={e => setTpm(e.target.value)}/>
    <button className="button small" onClick={save} disabled={saving}>{saving ? "…" : "Set"}</button>
  </div>;
}
