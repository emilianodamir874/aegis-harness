---
sidebar_position: 1
---
import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';
import { RateLimits } from '@site/src/components/RateLimits';
import { OnboardingProviderSetup } from '@site/src/components/OnboardingProviderSetup';
import { ModelSelectionTip } from '@site/src/components/ModelSelectionTip';
import MacDesktopInstallButtons from '@site/src/components/MacDesktopInstallButtons';
import WindowsDesktopInstallButtons from '@site/src/components/WindowsDesktopInstallButtons';
import LinuxDesktopInstallButtons from '@site/src/components/LinuxDesktopInstallButtons';
import { PanelLeft } from 'lucide-react';

# Install aegis

<Tabs>
  <TabItem value="mac" label="macOS" default>
    Choose to install the Desktop and/or CLI version of aegis:

    <Tabs groupId="interface">
      <TabItem value="ui" label="aegis Desktop" default>
        Install aegis Desktop directly from the browser or with [Homebrew](https://brew.sh/).

        <h3 style={{ marginTop: '1rem' }}>Option 1: Install via Download</h3>
        <MacDesktopInstallButtons/>

        <div style={{ marginTop: '1rem' }}>
          1. Unzip the downloaded zip file.
          2. Run the executable file to launch the aegis Desktop application.

          :::tip Updating aegis
          It's best to periodically [update aegis](/docs/guides/updating-aegis).
          :::
        </div>
        <h3>Option 2: Install via Homebrew</h3>
        Homebrew downloads the [same app](https://github.com/Homebrew/homebrew-cask/blob/master/Casks/b/block-goose.rb) but can take care of updates too.
        ```bash
        brew install --cask block-goose
        ```
        ---
        <div style={{ marginTop: '1rem' }}>
          :::info Permissions
          If you're on an Apple Mac M3 and the aegis Desktop app shows no window on launch, check and update the following:

          Ensure the `~/.config` directory has read and write access.

          aegis needs this access to create the log directory and file. Once permissions are granted, the app should load correctly. For steps on how to do this, refer to the  [Known Issues Guide](/docs/troubleshooting/known-issues#macos-permission-issues)
          :::
        </div>
      </TabItem>
      <TabItem value="cli" label="aegis CLI">
        Install aegis directly from the browser or with [Homebrew](https://brew.sh/).

        <h3 style={{ marginTop: '1rem' }}>Option 1: Install via Download script</h3>
        Run the following command to install the latest version of aegis on macOS:

        ```sh
        curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash
        ```
        This script will fetch the latest version of aegis and set it up on your system.

        If you'd like to install without interactive configuration, disable `CONFIGURE`:

        ```sh
        curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | CONFIGURE=false bash
        ```

        :::tip Updating aegis
        It's best to keep aegis updated. To update aegis, run:
        ```sh
        aegis update
        ```
        :::

        <h3>Option 2: Install via Homebrew</h3>
        Homebrew downloads the [a precompiled CLI tool](https://github.com/Homebrew/homebrew-core/blob/master/Formula/b/block-goose-cli.rb) and can take care of updates.
        ```bash
        brew install block-goose-cli
        ```
      </TabItem>
    </Tabs>
  </TabItem>

  <TabItem value="linux" label="Linux">
    Choose to install the Desktop and/or CLI version of aegis:

    <Tabs groupId="interface">
      <TabItem value="ui" label="aegis Desktop" default>
        Install aegis Desktop directly from the browser.

        <h3 style={{ marginTop: '1rem' }}>Install via Download</h3>
        <LinuxDesktopInstallButtons/>

        <div style={{ marginTop: '1rem' }}>
          **For Debian/Ubuntu-based distributions:**
          1. Download the DEB file
          2. Navigate to the directory where it is saved in a terminal
          3. Run `sudo dpkg -i (filename).deb`
          4. Launch aegis from the app menu

          :::tip Updating aegis
          It's best to periodically [update aegis](/docs/guides/updating-aegis).
          :::
        </div>
      </TabItem>
      <TabItem value="cli" label="aegis CLI">
        Run the following command to install the aegis CLI on Linux:

        ```sh
        curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash
        ```
        This script will fetch the latest version of aegis and set it up on your system.

        If you'd like to install without interactive configuration, disable `CONFIGURE`:

        ```sh
        curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | CONFIGURE=false bash
        ```

        :::tip Updating aegis
        It's best to keep aegis updated. To update aegis, run:
        ```sh
        aegis update
        ```
        :::
      </TabItem>
    </Tabs>
  </TabItem>

  <TabItem value="windows" label="Windows">
    Choose to install the Desktop and/or CLI version of aegis:

    <Tabs groupId="interface">
      <TabItem value="ui" label="aegis Desktop" default>
        Install aegis Desktop directly from the browser.

        <h3 style={{ marginTop: '1rem' }}>Install via Download</h3>
        <WindowsDesktopInstallButtons/>

        <div style={{ marginTop: '1rem' }}>
          1. Unzip the downloaded zip file.
          2. Run the executable file to launch the aegis Desktop application.

          :::tip Updating aegis
          It's best to periodically [update aegis](/docs/guides/updating-aegis).
          :::
        </div>
      </TabItem>
      <TabItem value="cli" label="aegis CLI">
        To install aegis natively on Windows, you need one of the following environments:
        - **Git Bash** (recommended): Comes with [Git for Windows](https://git-scm.com/download/win)
        - **MSYS2**: Available from [msys2.org](https://www.msys2.org/)
        - **PowerShell**: Available on Windows 10/11 by default

        **Git Bash / MSYS2: Standard**

        ```bash
        curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash
        ```

        To install without interactive configuration, disable `CONFIGURE`:

        ```bash
        curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | CONFIGURE=false bash
        ```

        **PowerShell Installation: Standard**
        Download the PowerShell installation script to your current directory.

        ```powershell
        Invoke-WebRequest -Uri "https://raw.githubusercontent.com/aaif-goose/goose/main/download_cli.ps1" -OutFile "download_cli.ps1";
        ```
        Then run the script to install aegis:
        ```powershell
        .\download_cli.ps1
        ```

        :::info Windows PATH Setup
        If you see a warning that aegis is not in your PATH, you need to add aegis to your PATH:

        <details>
          <summary>For Git Bash/MSYS2</summary>
          ```bash
          echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
          source ~/.bashrc
          ```
        </details>

        <details>
          <summary>For PowerShell</summary>
          ```powershell
          # Add to your PowerShell profile
          $profilePath = $PROFILE
          if (!(Test-Path $profilePath)) { New-Item -Path $profilePath -ItemType File -Force }
          Add-Content -Path $profilePath -Value '$env:PATH = "$env:USERPROFILE\.local\bin;$env:PATH"'
          # Reload profile or restart PowerShell
          . $PROFILE
          ```
        </details>

        After updating your PATH, you can run `aegis` commands from any directory.
        :::

        <details>
        <summary>Install via Windows Subsystem for Linux (WSL)</summary>

          We recommend running the aegis CLI natively on Windows, but you can use WSL if you prefer a Linux-like environment.

          1. Open [PowerShell](https://learn.microsoft.com/en-us/powershell/scripting/install/installing-powershell-on-windows) as Administrator and install WSL and the default Ubuntu distribution:

          ```bash
          wsl --install
          ```

          2. If prompted, restart your computer to complete the WSL installation. Once restarted, or if WSL is already installed, launch your Ubuntu shell by running:

          ```bash
          wsl -d Ubuntu
          ```

          3. Run the aegis installation script:
          ```bash
          curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash
          ```
          :::tip
            If you encounter any issues on download, you might need to install `bzip2` to extract the downloaded file:

            ```bash
            sudo apt update && sudo apt install bzip2 -y
            ```
          :::

          If you'd like to install without interactive configuration, disable `CONFIGURE`:

          ```sh
          curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | CONFIGURE=false bash
          ```

          If needed, add aegis to your path:

          ```
          echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
          echo 'export OPENAI_API_KEY=your_api_key' >> ~/.bashrc
          source ~/.bashrc
          ```

        </details>
      </TabItem>
    </Tabs>
  </TabItem>
</Tabs>

## Set LLM Provider
aegis works with [supported LLM providers][providers] that give aegis the AI intelligence it needs to understand your requests. On first use, you'll be prompted to configure your preferred provider.

<Tabs groupId="interface">
  <TabItem value="ui" label="aegis Desktop" default>
    On the welcome screen the first time you open aegis, choose how to configure a provider:
    <OnboardingProviderSetup />
  </TabItem>
  <TabItem value="cli" label="aegis CLI">
    The CLI automatically enters configuration mode where you can choose how to configure a provider:

    - **OpenRouter Login** - Sign in with OpenRouter to automatically configure models
    - **Tetrate Agent Router Service Login** - Sign in with Tetrate Agent Router Service to automatically configure models
    - **Manual Configuration** - Choose a provider and enter credentials manually

    Example configuration flow:

    ```
    ┌   aegis-configure
    │
    ◇ How would you like to set up your provider?
    │ Tetrate Agent Router Service Login
    │
    Opening browser for Tetrate Agent Router Service authentication...
    [aegis opens the browser and prints details]

    Authentication complete!

    Configuring Tetrate Agent Router Service...
    ✓ Tetrate Agent Router Service configuration complete
    ✓ Models configured successfully

    Testing configuration...
    ✓ Configuration test passed!
    ✓ Developer extension enabled!
    └ Tetrate Agent Router Service setup complete! You can now use aegis.
  ```

  :::info Windows Users
  If you choose to manually configure a provider, when prompted during configuration, choose to not store to keyring. If you encounter keyring errors when setting API keys, you can set environment variables manually instead:

  ```bash
  export OPENAI_API_KEY={your_api_key}
  ```

  Then run `aegis configure` again. aegis will detect the environment variable and display:

  ```
  ● OPENAI_API_KEY is set via environment variable
  ```

  To make API keys persist across sessions, add them to your shell profile:
  ```bash
  echo 'export OPENAI_API_KEY=your_api_key' >> ~/.bashrc
  source ~/.bashrc
  ```
  :::
  </TabItem>
</Tabs>

:::tip
<ModelSelectionTip />
:::

:::info Free Credits Offer
You'll receive $10 in free credits the first time you automatically authenticate with Tetrate through aegis. This offer is available to both new and existing Tetrate users.
:::

## Update Provider
You can change your LLM provider and/or model or update your API key at any time.

<Tabs groupId="interface">
  <TabItem value="ui" label="aegis Desktop" default>
    1. Click the <PanelLeft className="inline" size={16} /> button in the top-left to open the sidebar.
    2. Click the `Settings` button on the sidebar.
    3. Click the `Models` tab.
    4. Choose to update your provider, switch models, or click `Reset Provider and Model` to clear your settings and return to the welcome screen. See details about these [configuration options](/docs/getting-started/providers#configure-provider-and-model).
  </TabItem>
  <TabItem value="cli" label="aegis CLI">
    1. Run the following command:
    ```sh
    aegis configure
    ```
    2. Select `Configure Providers` from the menu.
    3. Follow the prompts to choose your LLM provider and enter or update your API key.

    **Example:**

    To select an option during configuration, use the up and down arrows to highlight your choice then press Enter.

    ```
    ┌   aegis-configure
    │
    ◇ What would you like to configure?
    │ Configure Providers
    │
    ◇ Which model provider should we use?
    │ Google Gemini
    │
    ◇ Provider Google Gemini requires GOOGLE_API_KEY, please enter a value
    │▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪
    │
    ◇ Enter a model from that provider:
    │ gemini-2.0-flash-exp
    │
    ◇  Hello there! You're all set to use me, so please ask away!
    │
    └  Configuration saved successfully
    ```
  </TabItem>
</Tabs>

<RateLimits />

## Running aegis

<Tabs groupId="interface">
    <TabItem value="ui" label="aegis Desktop" default>
        Starting a session in the aegis Desktop is straightforward. After choosing your provider, you'll see the session interface ready for use.

        Type your questions, tasks, or instructions directly into the input field, and aegis will get to work immediately.
    </TabItem>
    <TabItem value="cli" label="aegis CLI">
        From your terminal, navigate to the directory you'd like to start from and run:
        ```sh
        aegis session
        ```
    </TabItem>
</Tabs>

## Shared Configuration Settings

The aegis CLI and Desktop UI share all core configurations, including LLM provider settings, model selection, and extension configurations. When you install or configure extensions in either interface, the settings are stored in a central location, making them available to both the Desktop application and CLI. This makes it convenient to switch between interfaces while maintaining consistent settings. For more information, visit the [Config Files][config-files] guide.

:::info
While core configurations are shared between interfaces, extensions have flexibility in how they store authentication credentials. Some extensions may use the shared config files while others implement their own storage methods.
:::

<Tabs groupId="interface">
    <TabItem value="ui" label="aegis Desktop" default>
        Navigate to shared configurations through:
        1. Click the <PanelLeft className="inline" size={16} /> button in the top-left to open the sidebar.
        2. Click the `Settings` button on the sidebar.
    </TabItem>
    <TabItem value="cli" label="aegis CLI">
        Use the following command to manage shared configurations:
        ```sh
        aegis configure
        ```
    </TabItem>
</Tabs>

## Pin a aegis version in CI/CD
In CI/CD (and other automated, non-interactive environments), pin a specific version with `AEGIS_VERSION` to make installs reproducible and avoid 404s when downloading the aegis CLI binary assets if the `stable` release tag doesn’t include them.

See [CI/CD Environments](/docs/tutorials/cicd) for a complete example and usage details.

## Generate manpages for Linux distributions

If you're packaging aegis for a Linux distribution or creating a custom build, you can generate Unix manpages from the CLI command definitions:

```bash
just generate-manpages
```

This creates ROFF-formatted manpages in `target/man/` (e.g., `aegis.1`, `aegis-session.1`) that can be installed to `/usr/share/man/man1/` to provide offline documentation via the `man` command.

Manpage generation requires the aegis source repository and is intended for distribution packagers preparing packages for Fedora, Debian, and other Linux distributions. See the [generate_manpages.rs source](https://github.com/aaif-goose/goose/blob/main/crates/aegis-cli/src/bin/generate_manpages.rs) for implementation details.

## Additional Resources

You can also configure Extensions to extend aegis's functionality, including adding new ones or toggling them on and off. For detailed instructions, visit the [Using Extensions Guide][using-extensions].

[using-extensions]: /docs/getting-started/using-extensions
[providers]: /docs/getting-started/providers
[handling-rate-limits]: /docs/guides/handling-llm-rate-limits-with-aegis
[mcp]: https://www.anthropic.com/news/model-context-protocol
[config-files]: /docs/guides/config-files.md
