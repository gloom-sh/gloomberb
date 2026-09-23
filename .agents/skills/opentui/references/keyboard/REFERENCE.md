# Keyboard Input Handling

How to handle keyboard input in OpenTUI applications.

## Overview

OpenTUI provides keyboard input handling through:
- **Core**: `renderer.keyInput` EventEmitter
- **React**: `useKeyboard()` hook
- **Solid**: `useKeyboard()` hook

## When to Use

Use this reference when you need keyboard shortcuts, focus-aware input handling, or custom keybindings.

## KeyEvent Object

All keyboard handlers receive a `KeyEvent` object:

```typescript
interface KeyEvent {
  name: string          // Key name: "a", "escape", "f1", etc.
  sequence: string      // Raw escape sequence
  ctrl: boolean         // Ctrl modifier held
  shift: boolean        // Shift modifier held
  meta: boolean         // Alt modifier held
  option: boolean       // Option modifier held (macOS)
  eventType: "press" | "release" | "repeat"
  repeated: boolean     // Key is being held (repeat event)
}
```

## Basic Usage

### Core

```typescript
import { createCliRenderer, type KeyEvent } from "@opentui/core"

const renderer = await createCliRenderer()

renderer.keyInput.on("keypress", (key: KeyEvent) => {
  if (key.name === "escape") {
    renderer.destroy()
    return
  }
  
  if (key.ctrl && key.name === "s") {
    saveDocument()
  }
})
```

### React

```tsx
import { useKeyboard, useRenderer } from "@opentui/react"

function App() {
  const renderer = useRenderer()
  useKeyboard((key) => {
    if (key.name === "escape") {
      renderer.destroy()
    }
  })
  
  return <text>Press ESC to exit</text>
}
```


### Solid

```tsx
import { useKeyboard, useRenderer } from "@opentui/solid"

function App() {
  const renderer = useRenderer()
  useKeyboard((key) => {
    if (key.name === "escape") {
      renderer.destroy()
    }
  })
  
  return <text>Press ESC to exit</text>
}
```

## Key Names

### Alphabetic Keys

Lowercase: `a`, `b`, `c`, ... `z`

With Shift: Check `key.shift && key.name === "a"` for uppercase

### Numeric Keys

`0`, `1`, `2`, ... `9`

### Function Keys

`f1`, `f2`, `f3`, ... `f12`

### Special Keys

| Key Name | Description |
|----------|-------------|
| `escape` | Escape key |
| `enter` | Enter/Return |
| `return` | Enter/Return (alias) |
| `tab` | Tab key |
| `backspace` | Backspace |
| `delete` | Delete key |
| `space` | Spacebar |

### Arrow Keys

| Key Name | Description |
|----------|-------------|
| `up` | Up arrow |
| `down` | Down arrow |
| `left` | Left arrow |
| `right` | Right arrow |

### Navigation Keys

| Key Name | Description |
|----------|-------------|
| `home` | Home key |
| `end` | End key |
| `pageup` | Page Up |
| `pagedown` | Page Down |
| `insert` | Insert key |

## Modifier Keys

Check modifier properties on `KeyEvent`:

```typescript
renderer.keyInput.on("keypress", (key) => {
  if (key.ctrl && key.name === "c") {
    // Ctrl+C
  }
  
  if (key.shift && key.name === "tab") {
    // Shift+Tab
  }
  
  if (key.meta && key.name === "s") {
    // Alt+S (meta = Alt on most systems)
  }
  
  if (key.option && key.name === "a") {
    // Option+A (macOS)
  }
})
```

### Modifier Combinations

```typescript
// Ctrl+Shift+S
if (key.ctrl && key.shift && key.name === "s") {
  saveAs()
}

// Ctrl+Alt+Delete (careful with system shortcuts!)
if (key.ctrl && key.meta && key.name === "delete") {
  // ...
}
```

## Event Types

### Press Events (Default)

Normal key press:

```typescript
renderer.keyInput.on("keypress", (key) => {
  if (key.eventType === "press") {
    // Initial key press
  }
})
```

### Repeat Events

Key held down:

```typescript
renderer.keyInput.on("keypress", (key) => {
  if (key.eventType === "repeat" || key.repeated) {
    // Key is being held
  }
})
```

### Release Events

Key released (opt-in):

```tsx
// React
useKeyboard(
  (key) => {
    if (key.eventType === "release") {
      // Key released
    }
  },
  { release: true }  // Enable release events
)

// Solid
useKeyboard(
  (key) => {
    if (key.eventType === "release") {
      // Key released
    }
  },
  { release: true }
)
```

## Patterns

### Navigation Menu

```tsx
function Menu() {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const items = ["Home", "Settings", "Help", "Quit"]
  
  useKeyboard((key) => {
    switch (key.name) {
      case "up":
      case "k":
        setSelectedIndex(i => Math.max(0, i - 1))
        break
      case "down":
      case "j":
        setSelectedIndex(i => Math.min(items.length - 1, i + 1))
        break
      case "enter":
        handleSelect(items[selectedIndex])
        break
    }
  })
  
  return (
    <box flexDirection="column">
      {items.map((item, i) => (
        <text
          key={item}
          fg={i === selectedIndex ? "#00FF00" : "#FFFFFF"}
        >
          {i === selectedIndex ? "> " : "  "}{item}
        </text>
      ))}
    </box>
  )
}
```

### Modal Escape

```tsx
function Modal({ onClose, children }) {
  useKeyboard((key) => {
    if (key.name === "escape") {
      onClose()
    }
  })
  
  return (
    <box border padding={2}>
      {children}
    </box>
  )
}
```

### Vim-style Modes

```tsx
function Editor() {
  const [mode, setMode] = useState<"normal" | "insert">("normal")
  const [content, setContent] = useState("")
  
  useKeyboard((key) => {
    if (mode === "normal") {
      switch (key.name) {
        case "i":
          setMode("insert")
          break
        case "escape":
          // Already in normal mode
          break
        case "j":
          moveCursorDown()
          break
        case "k":
          moveCursorUp()
          break
      }
    } else if (mode === "insert") {
      if (key.name === "escape") {
        setMode("normal")
      }
      // Input component handles text in insert mode
    }
  })
  
  return (
    <box flexDirection="column">
      <text>Mode: {mode}</text>
      <textarea
        value={content}
        onChange={setContent}
        focused={mode === "insert"}
      />
    </box>
  )
}
```

### Game Controls

```tsx
function Game() {
  const [pressed, setPressed] = useState(new Set<string>())
  
  useKeyboard(
    (key) => {
      setPressed(keys => {
        const newKeys = new Set(keys)
        if (key.eventType === "release") {
          newKeys.delete(key.name)
        } else {
          newKeys.add(key.name)
        }
        return newKeys
      })
    },
    { release: true }
  )
  
  // Game logic uses pressed set
  useEffect(() => {
    if (pressed.has("up") || pressed.has("w")) {
      moveUp()
    }
    if (pressed.has("down") || pressed.has("s")) {
      moveDown()
    }
  }, [pressed])
  
  return <text>WASD or arrows to move</text>
}
```

### Keyboard Shortcuts Help

```tsx
function ShortcutsHelp() {
  const shortcuts = [
    { keys: "Ctrl+S", action: "Save" },
    { keys: "Ctrl+Q", action: "Quit" },
    { keys: "Ctrl+F", action: "Find" },
    { keys: "Tab", action: "Next field" },
    { keys: "Shift+Tab", action: "Previous field" },
  ]
  
  return (
    <box border title="Keyboard Shortcuts" padding={1}>
      {shortcuts.map(({ keys, action }) => (
        <box key={keys} flexDirection="row">
          <text width={15} fg="#00FFFF">{keys}</text>
          <text>{action}</text>
        </box>
      ))}
    </box>
  )
}
```

## Paste Events

Handle pasted text:

### Core

```typescript
renderer.keyInput.on("paste", (text: string) => {
  console.log("Pasted:", text)
})
```

### Solid

Solid provides a dedicated `usePaste` hook:

```tsx
import { usePaste } from "@opentui/solid"

function App() {
  usePaste((event) => {
    console.log("Pasted:", event.text)
  })
  
  return <text>Paste something</text>
}
```

> **Note**: `usePaste` is **Solid-only**. React does not have this hook - handle paste via the Core event emitter or input component's `onChange`.

## Clipboard API (OSC 52)

Copy text to the system clipboard using OSC 52 escape sequences. Works over SSH and in most modern terminal emulators.

### Core

```typescript
// Copy to clipboard
const success = renderer.copyToClipboardOSC52("text to copy")

// Check if OSC 52 is supported
if (renderer.isOsc52Supported()) {
  renderer.copyToClipboardOSC52("Hello!")
}

// Clear clipboard
renderer.clearClipboardOSC52()

// Target specific clipboard (X11)
import { ClipboardTarget } from "@opentui/core"
renderer.copyToClipboardOSC52("text", ClipboardTarget.Primary)   // X11 primary
renderer.copyToClipboardOSC52("text", ClipboardTarget.Clipboard) // System clipboard (default)
```

### From Selection

The Selection object provides a convenience method:

```tsx
// Solid
useSelectionHandler((selection) => {
  selection.copyToClipboard()  // Uses OSC 52 internally
})
```

## Focus and Input Components

Input components (`<input>`, `<textarea>`, `<select>`) capture keyboard events when focused:

```tsx
<input focused />  // Receives keyboard input

// Global useKeyboard still fires, but input consumes characters
```

To prevent conflicts, check if an input is focused before handling global shortcuts:

```tsx
function App() {
  const renderer = useRenderer()
  const [inputFocused, setInputFocused] = useState(false)
  
  useKeyboard((key) => {
    if (inputFocused) return  // Let input handle it
    
    // Global shortcuts
    if (key.name === "escape") {
      renderer.destroy()
    }
  })
  
  return (
    <input
      focused={inputFocused}
      onFocus={() => setInputFocused(true)}
      onBlur={() => setInputFocused(false)}
    />
  )
}
```

## Gotchas

### Terminal Limitations

Some key combinations are captured by the terminal or OS:
- `Ctrl+C` often sends SIGINT (use `exitOnCtrlC: false` to handle)
- `Ctrl+Z` suspends the process
- Some function keys may be intercepted

### SSH and Remote Sessions

Key detection may vary over SSH. Test on target environments.

### Multiple Handlers

Multiple `useKeyboard` calls all receive events. Coordinate handlers to prevent conflicts.

## See Also

- [React API](../react/api.md) - `useKeyboard` hook reference
- [Solid API](../solid/api.md) - `useKeyboard` hook reference
- [Input Components](../components/inputs.md) - Focus management with input, textarea, select
- [Testing](../testing/REFERENCE.md) - Simulating key presses in tests
