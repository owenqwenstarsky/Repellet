import { useState } from 'react';
export default function App() {
  const [count, setCount] = useState(0);
  return (
    <main style={{ fontFamily: 'system-ui', maxWidth: 640, margin: '80px auto', padding: 24 }}>
      <h1>Hello from Repellet</h1>
      <p>Edit src/App.tsx and watch your preview update.</p>
      <button onClick={() => setCount(count + 1)}>Clicked {count} times</button>
    </main>
  );
}
