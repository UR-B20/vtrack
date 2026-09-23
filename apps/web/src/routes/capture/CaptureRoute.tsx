/**
 * /capture — point A. Placeholder for M0.
 *
 * The real page (§6.2) is M1/M2: getUserMedia, a draggable lane ROI, presence + motion
 * gating so a stationary vehicle keeps being sampled without burning mobile data, and
 * POST /recognise against the engine. None of that exists yet, and a half-built camera
 * page would be worse than an honest one.
 */
export function CaptureRoute() {
  return (
    <div className="placeholder">
      <span className="wordmark" style={{ fontSize: 30 }}>VTRACK</span>
      <span className="placeholder__ms">CAPTURE · M1</span>
      <p className="placeholder__note">
        The camera node arrives with the engine in M1. Until then the gate display runs on
        simulated events, and the approved list is searchable at any time from
        <span className="mono"> /display</span>.
      </p>
    </div>
  )
}
