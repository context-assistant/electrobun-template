import "./index.css";
import { InAppDialogsProvider } from "./context/InAppDialogsContext";
import { AppLayout } from "./layout/AppLayout";

export function App() {
  return (
    <InAppDialogsProvider>
      <AppLayout />
    </InAppDialogsProvider>
  );
}

export default App;
