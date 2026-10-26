import { useRoute } from './lib/router'
import { DisplayGate } from './routes/display/DisplayGate'
import { AdminRoute } from './routes/admin/AdminRoute'
import { CaptureRoute } from './routes/capture/CaptureRoute'

export function App() {
  const [route] = useRoute()
  switch (route) {
    case 'admin':   return <AdminRoute />
    case 'capture': return <CaptureRoute />
    case 'display': return <DisplayGate />
  }
}
