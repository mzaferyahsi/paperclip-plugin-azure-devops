import type { ReactNode } from 'react';
export const css = `
.ado{display:grid;gap:16px;font-size:13px;min-width:0;max-width:1000px}.ado *{box-sizing:border-box}
.ado h2{font-size:16px;margin:0}.ado h3{font-size:14px;margin:0}.ado p{margin:0}.ado .muted{color:var(--muted-foreground)}
.ado button,.ado select,.ado input{font:inherit}.ado :focus-visible{outline:2px solid var(--ring);outline-offset:1px}
.ado .row{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center}
.ado .btn{padding:6px 12px;min-height:28px;border:1px solid var(--border);border-radius:6px;background:transparent;color:var(--foreground);cursor:pointer}
.ado .btn:hover:not(:disabled){background:var(--accent)}.ado .btn.primary{background:var(--primary);color:var(--primary-foreground);border-color:var(--primary)}.ado .btn:disabled{opacity:.5;cursor:not-allowed}
.ado .field{display:grid;gap:4px}.ado .field label,.ado legend{font-weight:600}.ado .hint{color:var(--muted-foreground);font-size:12px}
.ado input[type=text],.ado select{padding:6px 8px;min-height:28px;border:1px solid var(--border);border-radius:6px;background:transparent;color:var(--foreground);max-width:100%}
.ado input[type=checkbox]{width:16px;height:16px;margin:0}
.ado fieldset{border:1px solid var(--border);border-radius:8px;padding:12px;display:grid;gap:8px;margin:0;min-width:0}
.ado .opt{display:flex;gap:8px;align-items:flex-start}.ado .scroll{overflow:auto;max-width:100%;max-height:200px}
.ado .banner{border:1px solid var(--border);border-left-width:4px;border-radius:6px;padding:8px 12px}
.ado .banner.error{border-left-color:var(--destructive)}.ado .banner.warn{border-left-color:#b45309}.ado .banner.ok{border-left-color:#16a34a}.ado .banner.info{border-left-color:#2563eb}
.ado table{border-collapse:collapse;width:100%}.ado th,.ado td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--border);vertical-align:top}
.ado .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all}
.ado .chip{display:inline-block;padding:1px 8px;border-radius:999px;border:1px solid var(--border);font-size:12px}
.ado .chip.success{border-color:#16a34a;color:#16a34a}.ado .chip.danger{border-color:var(--destructive);color:var(--destructive)}.ado .chip.warning{border-color:#b45309;color:#b45309}.ado .chip.info{border-color:#2563eb;color:#2563eb}
.ado .tabs{display:flex;gap:2px;border-bottom:1px solid var(--border);overflow-x:auto;position:sticky;top:0;background:var(--background);z-index:2}
.ado .tab{appearance:none;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--muted-foreground);padding:8px 12px;cursor:pointer;white-space:nowrap;font-weight:500}
.ado .tab:hover{color:var(--foreground)}.ado .tab[aria-selected=true]{color:var(--foreground);border-bottom-color:var(--primary);font-weight:600}
.ado .tab .dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-left:6px;background:#b45309}.ado .tab .dot.bad{background:var(--destructive)}
.ado .card{border:1px solid var(--border);border-radius:8px;padding:14px 16px;display:grid;gap:10px;min-width:0}
.ado .card>header{display:grid;gap:2px}.ado .card>header h3{font-size:14px}
.ado .cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}
.ado .stat{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ado .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.ado .tile{border:1px solid var(--border);border-radius:8px;padding:10px 12px;display:grid;gap:2px}.ado .tile .big{font-size:18px;font-weight:600}
.ado .savebar{position:sticky;bottom:0;display:flex;gap:8px 12px;align-items:center;flex-wrap:wrap;padding:10px 14px;border:1px solid var(--border);border-radius:8px;background:var(--background);box-shadow:0 -4px 12px rgba(0,0,0,.08);z-index:3}
.ado .savebar.dirty{border-color:#b45309}.ado .savebar .grow{flex:1;min-width:120px}
.ado .matrix{overflow:auto;max-width:100%;max-height:420px}.ado .matrix table th{position:sticky;top:0;background:var(--background);white-space:nowrap}
.ado .matrix td.c,.ado .matrix th.c{text-align:center}.ado .matrix td.warn{background:rgba(180,83,9,.08)}
.ado .seg{display:inline-flex;border:1px solid var(--border);border-radius:6px;overflow:hidden}.ado .seg button{border:0;background:transparent;color:var(--foreground);padding:6px 12px;cursor:pointer}.ado .seg button[aria-pressed=true]{background:var(--primary);color:var(--primary-foreground)}
.ado .two{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:640px){.ado .two{grid-template-columns:1fr}}
.ado input[type=number],.ado input[type=password],.ado input[type=search]{padding:6px 8px;min-height:28px;border:1px solid var(--border);border-radius:6px;background:transparent;color:var(--foreground);max-width:100%}
.ado details.sub>summary{cursor:pointer;font-weight:600}
.ado .opt label{font-weight:400}.ado .opt label>.hint{display:block}
`;
export const Styles = () => <style>{css}</style>;
export const Banner = ({ tone, children }: { tone: 'error' | 'warn' | 'ok' | 'info'; children: ReactNode }) => <div className={`banner ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>{children}</div>;
export const Btn = ({ children, onClick, primary, disabled }: { children: ReactNode; onClick: () => void; primary?: boolean; disabled?: boolean }) => <button type="button" className={`btn${primary ? ' primary' : ''}`} onClick={onClick} disabled={disabled}>{children}</button>;
export const ago = (iso?: string | null): string => {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};
export const tone = (t?: string): string => (t === 'success' ? 'success' : t === 'danger' ? 'danger' : t === 'warning' ? 'warning' : t === 'info' ? 'info' : '');
export const Chip = ({ label, t }: { label: string; t?: string }) => <span className={`chip ${tone(t)}`}>{label}</span>;
