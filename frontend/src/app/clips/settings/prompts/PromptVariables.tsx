"use client";

interface VariableDetail {
  description: string;
  example: string;
}

interface PromptVariablesProps {
  vars: string[];
  varDetails?: Record<string, VariableDetail>;
  onInsert: (varName: string) => void;
}

export function PromptVariables({ vars, varDetails = {}, onInsert }: PromptVariablesProps) {
  if (vars.length === 0) return null;

  return (
    <div className="space-y-3">
      <label className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        Available variables - click a variable to insert it at the cursor
      </label>
      <div className="grid gap-2 sm:grid-cols-2">
        {vars.map((varName) => {
          const detail = varDetails[varName];

          return (
            <button
              key={varName}
              type="button"
              onClick={() => onInsert(varName)}
              className="group rounded-xl border border-muted-foreground/10 bg-card/50 px-3 py-2.5 text-left transition-colors hover:border-primary/30 hover:bg-primary/5"
            >
              <span className="font-mono text-xs font-semibold text-primary">
                {`{{${varName}}}`}
              </span>
              {detail ? (
                <span className="mt-1.5 block space-y-1">
                  <span className="block text-xs leading-relaxed text-muted-foreground">
                    {detail.description}
                  </span>
                  <span className="block text-[11px] leading-relaxed text-muted-foreground/80">
                    Example: <span className="font-mono text-foreground/80">{detail.example}</span>
                  </span>
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
