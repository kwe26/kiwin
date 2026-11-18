"use client";

import { useState } from "react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { createDatabase } from "@/app/actions";

export function CreateDatabaseForm() {
    const [custom, setCustom] = useState(false);
    return (
        <ActionForm action={createDatabase} className="stack" resetOnSuccess>
            <label>Database name
                <input type="text" name="name" placeholder="shop" required pattern="[A-Za-z0-9_]{1,32}" title="1-32 letters, digits or _" autoCapitalize="none" spellCheck={false} autoFocus />
            </label>
            <div className="ssl-box">
                <label className="check">
                    <input type="checkbox" name="custom" checked={custom} onChange={(e) => setCustom(e.target.checked)} />
                    <span>Custom user and password</span>
                </label>
                <p className="hint">Otherwise a user with the same name as the database and a random password are created.</p>
                {custom && (
                    <div className="grid form-grid">
                        <label><span className="label-text">User <span className="opt">(empty = database name)</span></span>
                            <input type="text" name="user" pattern="[A-Za-z0-9_]{1,32}" title="1-32 letters, digits or _" autoCapitalize="none" spellCheck={false} autoComplete="off" />
                        </label>
                        <label><span className="label-text">Password <span className="opt">(empty = generate)</span></span>
                            <input type="password" name="password" minLength={8} autoComplete="new-password" />
                        </label>
                    </div>
                )}
            </div>
            <div className="row"><SubmitButton>Create database</SubmitButton></div>
        </ActionForm>
    );
}
