import "./index.css";

import logo from "./design/logo.svg";
import { useAppDispatch, useAppSelector } from "./app/hooks";
import { addBy, decrement, increment, reset } from "./features/counter/counterSlice";

export function App() {
  const value = useAppSelector(state => state.counter.value);
  const dispatch = useAppDispatch();

  return (
    <div className="container mx-auto p-8 text-center relative z-10">
      <div className="flex justify-center items-center gap-8 mb-8">
        <img
          src={logo}
          alt="Bun Logo"
          className="h-36 p-6 transition-all duration-300 hover:drop-shadow-[0_0_2em_#646cffaa] scale-120"
        />
      </div>

      <div className="mx-auto max-w-md rounded-xl border bg-card text-card-foreground p-6 shadow-sm">
        <div className="text-sm text-muted-foreground mb-2">Redux Toolkit demo</div>
        <div className="text-4xl font-semibold tabular-nums mb-6">{value}</div>

        <div className="flex flex-wrap justify-center gap-2">
          <button
            type="button"
            className="rounded-md border px-3 py-2 text-sm hover:bg-muted"
            onClick={() => dispatch(decrement())}
          >
            -1
          </button>
          <button
            type="button"
            className="rounded-md border px-3 py-2 text-sm hover:bg-muted"
            onClick={() => dispatch(increment())}
          >
            +1
          </button>
          <button
            type="button"
            className="rounded-md border px-3 py-2 text-sm hover:bg-muted"
            onClick={() => dispatch(addBy(5))}
          >
            +5
          </button>
          <button
            type="button"
            className="rounded-md border px-3 py-2 text-sm hover:bg-muted"
            onClick={() => dispatch(reset())}
          >
            reset
          </button>
        </div>
      </div>
    </div>
  );
}

export default App;
