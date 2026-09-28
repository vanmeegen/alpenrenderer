/**
 * The steps to get the position working, shown where "Mein Standort" failed:
 * in the standpoint map and in the Standpunkt menu alike.
 */
import { LocationHelp } from './mapPicker';

export function LocationHelpBox({ help, onHide, className = '' }: { help: LocationHelp; onHide: () => void; className?: string }) {
  return (
    <div role="note" aria-label="Standort-Hilfe"
      className={`max-h-[40vh] overflow-auto rounded border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-neutral-800 ${className}`}>
      <div className="flex items-baseline gap-3">
        <b className="font-semibold">{help.title}</b>
        <button className="ml-auto text-blue-700" onClick={onHide}>Ausblenden</button>
      </div>
      <ol className="mt-1 list-decimal pl-4">
        {help.steps.map((t) => <li key={t}>{t}</li>)}
      </ol>
    </div>
  );
}
