import { formatClock } from '../../lib/format'
import { formatPlate } from '../../lib/plates'
import { SearchIcon } from '../../lib/icons'
import { RAIL_WORD, type EventRow } from '../../lib/types'
import { toneOf } from './screen'

interface Props {
  events: EventRow[]
  dimmed: boolean
  onTypeAPlate: () => void
}

/**
 * The last five reads (§6.1): a right rail in landscape, a strip under the stage on the phone.
 *
 * The top row is highlighted because it is the MOST RECENT, not because it is on the
 * stage — which is why the highlight is still there in gate-standby.png after the stage
 * has cleared. Chips always render the best guess (plate_norm); the raw read appears
 * on an orange screen's line (screen.ts).
 */
export function Rail({ events, dimmed, onTypeAPlate }: Props) {
  return (
    <aside className={`rail${dimmed ? ' rail--dim' : ''}`}>
      <div className="rail__head">RECENT READS</div>

      <div className="rail__list">
        {events.length === 0 && <div className="rail__empty">No reads yet.</div>}
        {events.map((e, i) => (
          <div key={e.id} className={`rail__row${i === 0 && !dimmed ? ' rail__row--current' : ''}`}>
            <span className="rail__time">{formatClock(e.ts)}</span>
            <span className="plate plate--chip">{formatPlate(e.plate_norm ?? e.plate_raw ?? '')}</span>
            <span className="rail__decision" style={{ color: `var(--${toneOf(e)})` }}>
              <span className="rail__dot" />
              {RAIL_WORD[toneOf(e)]}
            </span>
          </div>
        ))}
      </div>

      {/* §6.1: "TYPE A PLATE in the rail is always available" — present in every state. */}
      <div className="rail__foot">
        <button type="button" className="rail__typebtn" onClick={onTypeAPlate}>
          <SearchIcon />
          TYPE A PLATE
        </button>
      </div>
    </aside>
  )
}
