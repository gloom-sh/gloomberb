# Terminal header frames

Actual OpenTUI Header captures against origin/main (5ce0c7c5) and this change. Trailing spaces in the code blocks preserve terminal cells.

The current baseline already preserves Help, the market summary, a compact failure signal, and clipping of transient notices. This change drops incomplete status parts whole.

## Idle

60 columns:

```text
Before   > Search or run a command  Ctrl+P                  Help ? 
After    > Search or run a command  Ctrl+P                  Help ? 
```

80 columns:

```text
Before   > Search or run a command  Ctrl+P                       Help ? SPY — base USD 
After    > Search or run a command  Ctrl+P                       Help ? SPY — base USD 
```

120 columns:

```text
Before   > Search or run a command  Ctrl+P                                                               Help ? SPY — base USD 
After    > Search or run a command  Ctrl+P                                                               Help ? SPY — base USD 
```

160 columns:

```text
Before   > Search or run a command  Ctrl+P                                                                                                       Help ? SPY — base USD 
After    > Search or run a command  Ctrl+P                                                                                                       Help ? SPY — base USD 
```

## Downloading

60 columns:

```text
Before   > Search or run a command  ⠋ Downloading v9... 42% Help ? 
After    > Search or run a command  ⠋ 42%                   Help ? 
```

80 columns:

```text
Before   > Search or run a command  ⠋ Downloading v... 42%       Help ? SPY — base USD 
After    > Search or run a command  ⠋ 42%                        Help ? SPY — base USD 
```

120 columns:

```text
Before   > Search or run a command  Ctrl+P          ⠋ Downloading v9.9.9: 42%                            Help ? SPY — base USD 
After    > Search or run a command  Ctrl+P          ⠋ Downloading v9.9.9: 42%                            Help ? SPY — base USD 
```

160 columns:

```text
Before   > Search or run a command  Ctrl+P                                                  ⠋ Downloading v9.9.9: 42%                            Help ? SPY — base USD 
After    > Search or run a command  Ctrl+P                                                  ⠋ Downloading v9.9.9: 42%                            Help ? SPY — base USD 
```

## Ready

60 columns:

```text
Before   > Search or run a command  Update ready, restar... Help ? 
After    > Search or run a command  Update ready            Help ? 
```

80 columns:

```text
Before   > Search or run a command  Update ready, resta...       Help ? SPY — base USD 
After    > Search or run a command  Update ready                 Help ? SPY — base USD 
```

120 columns:

```text
Before   > Search or run a command  Ctrl+P     Update ready, restart to apply                            Help ? SPY — base USD 
After    > Search or run a command  Ctrl+P     Update ready, restart to apply                            Help ? SPY — base USD 
```

160 columns:

```text
Before   > Search or run a command  Ctrl+P                                             Update ready, restart to apply                            Help ? SPY — base USD 
After    > Search or run a command  Ctrl+P                                             Update ready, restart to apply                            Help ? SPY — base USD 
```

## Failed

60 columns:

```text
Before   > Search or run a command  Update failed: downl... Help ? 
After    > Search or run a command  Update failed  U retry  Help ? 
```

80 columns:

```text
Before   > Search or run a command  Update failed  U retry       Help ? SPY — base USD 
After    > Search or run a command  Update failed  U retry       Help ? SPY — base USD 
```

120 columns:

```text
Before   > Search or run a command  Update failed: download interrupted                                  Help ? SPY — base USD 
After    > Search or run a command  Update failed: download interrupted                                  Help ? SPY — base USD 
```

160 columns:

```text
Before   > Search or run a command  Ctrl+P                               Update failed: download interrupted  U retry                            Help ? SPY — base USD 
After    > Search or run a command  Ctrl+P                               Update failed: download interrupted  U retry                            Help ? SPY — base USD 
```

## Notice

60 columns:

```text
Before   > Search or run a command  Update check failed:... Help ? 
After    > Search or run a command  Update check failed:... Help ? 
```

80 columns:

```text
Before   > Search or run a command  Update check failed...       Help ? SPY — base USD 
After    > Search or run a command  Update check failed...       Help ? SPY — base USD 
```

120 columns:

```text
Before   > Search or run a command  Update check failed: no connection, an...                            Help ? SPY — base USD 
After    > Search or run a command  Update check failed: no connection, an...                            Help ? SPY — base USD 
```

160 columns:

```text
Before   > Search or run a command  Ctrl+P           Update check failed: no connection, and some more words than fit                            Help ? SPY — base USD 
After    > Search or run a command  Ctrl+P           Update check failed: no connection, and some more words than fit                            Help ? SPY — base USD 
```

## Restart

60 columns:

```text
Before   > Search or run a command   Update ready Restart U Help ? 
After    > Search or run a command   Update ready Restart U Help ? 
```

80 columns:

```text
Before   > Search or run a command  Update ready Restart U       Help ? SPY — base USD 
After    > Search or run a command  Update ready Restart U       Help ? SPY — base USD 
```

120 columns:

```text
Before   > Search or run a command  Ctrl+P             Update ready Restart U                            Help ? SPY — base USD 
After    > Search or run a command  Ctrl+P             Update ready Restart U                            Help ? SPY — base USD 
```

160 columns:

```text
Before   > Search or run a command  Ctrl+P                                                     Update ready Restart U                            Help ? SPY — base USD 
After    > Search or run a command  Ctrl+P                                                     Update ready Restart U                            Help ? SPY — base USD 
```
