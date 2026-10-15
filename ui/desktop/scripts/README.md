# Aegisy

Put `aegisy` in your $PATH if you want to launch via:

```
aegisy .
```

This will open aegis GUI from any path you specify

# Unregister Deeplink Protocols (macos only)

`unregister-deeplink-protocols.js` is a script to unregister the deeplink protocol used by aegis like `aegis://`.
This is handy when you want to test deeplinks with the development version of Aegis.

# Usage

To unregister the deeplink protocols, run the following command in your terminal:
Then launch Aegis again and your deeplinks should work from the latest launched aegis application as it is registered on startup.

```bash
node scripts/unregister-deeplink-protocols.js
```

