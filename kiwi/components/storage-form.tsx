"use client";

import { useState } from "react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { createStorage } from "@/app/actions";

/** Preset sizes that fit the disk, a custom size, and Force setup for sizes beyond the free space. */
export function StorageForm({ sizes, freeGB, suggestedGB }: { sizes: string[]; freeGB: number; suggestedGB: number }) {
    const [choice, setChoice] = useState(sizes[0] ?? "custom");
    const [custom, setCustom] = useState(String(suggestedGB));
    const [force, setForce] = useState(false);
    const over = choice === "custom" && Number(custom) > freeGB;

    return (
        <ActionForm action={createStorage}>
            <label><span className="label-text">Setup code <span className="opt">(on the server: sudo kiwin setup-code)</span></span>
                        <input type="text" name="setupCode" required autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="XXXX-XXXX-XXXX" className="mono-input" />
                    </label>
            <fieldset className="choices" style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="stat-label" style={{ marginBottom: 8 }}>Volume size</legend>
                {sizes.map((size) => (
                    <label key={size} className="choice">
                        <input type="radio" name="size" value={size} checked={choice === size} onChange={() => setChoice(size)} />
                        <span>{size.replace("GB", " GB")}</span>
                    </label>
                ))}
                <label className="choice">
                    <input type="radio" name="size" value="custom" checked={choice === "custom"} onChange={() => setChoice("custom")} />
                    <span>Custom</span>
                </label>
            </fieldset>
            {choice === "custom" && (
                <label><span className="label-text">Size in GB <span className="opt">({freeGB} GB free on this disk)</span></span>
                    <input type="number" name="customGB" min={1} step={1} value={custom} onChange={(e) => setCustom(e.target.value)} required />
                </label>
            )}
            <label className="check">
                <input type="checkbox" name="force" checked={force} onChange={(e) => setForce(e.target.checked)} />
                <span>Force setup</span>
            </label>
            <p className="hint">
                Allows a volume larger than the free disk space. The volume only uses what its data needs, but if the disk really
                fills up, writes fail and data can be damaged. Keep an eye on free space.
            </p>
            {over && !force && <p className="notice notice-error">That is more than the {freeGB} GB free: choose less, or tick Force setup.</p>}
            <SubmitButton>Create storage</SubmitButton>
        </ActionForm>
    );
}
