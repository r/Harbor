-- Harbor Setup Assistant
-- A friendly GUI to help users finish setting up Harbor with unpacked Chrome extensions

use AppleScript version "2.4"
use scripting additions

-- Global variables
property harborDir : "/Library/Application Support/Harbor"
property chromeExtensionDir : "/Library/Application Support/Harbor/chrome-extension"
property webAgentsExtensionDir : "/Library/Application Support/Harbor/web-agents-chrome"

-- Main entry point
on run
	showWelcome()
end run

-- Welcome dialog
on showWelcome()
	set welcomeResult to display dialog "Welcome to Harbor! 🚀

Harbor has been installed on your Mac. To finish setup, you need to load the Chrome extensions in Developer Mode.

This assistant will guide you through the process." buttons {"Quit", "Let's Go!"} default button "Let's Go!" cancel button "Quit" with title "Harbor Setup Assistant" with icon note
	
	if button returned of welcomeResult is "Let's Go!" then
		showStep1()
	end if
end showWelcome

-- Step 1: Open Chrome Extensions page
on showStep1()
	set step1Result to display dialog "Step 1 of 5: Open Chrome Extensions

Click 'Open Extensions Page' to open Chrome's extension management page.

You'll be loading TWO extensions:
  • Harbor (core functionality)
  • Web Agents (window.ai API for web pages)

Once Chrome opens:
  • Enable 'Developer mode' (toggle in the top right)" buttons {"Back", "Open Extensions Page"} default button "Open Extensions Page" cancel button "Back" with title "Harbor Setup - Step 1" with icon note
	
	if button returned of step1Result is "Open Extensions Page" then
		-- Open Chrome extensions page
		try
			do shell script "open -a 'Google Chrome' 'chrome://extensions/'"
		on error
			try
				do shell script "open 'chrome://extensions/'"
			end try
		end try
		delay 1
		showStep2()
	else
		showWelcome()
	end if
end showStep1

-- Step 2: Load Harbor Extension
on showStep2()
	set step2Result to display dialog "Step 2 of 5: Load Harbor Extension

In Chrome:
  1. Make sure 'Developer mode' is ON (top right)
  2. Click 'Load unpacked'
  3. Navigate to and select:
     " & chromeExtensionDir & "

Click 'I Loaded It' when done, or 'Show in Finder' to open the folder." buttons {"Show in Finder", "I Loaded It"} default button "I Loaded It" with title "Harbor Setup - Step 2" with icon note
	
	if button returned of step2Result is "Show in Finder" then
		do shell script "open '" & chromeExtensionDir & "'"
		-- Show this step again
		showStep2()
	else
		showStep2b()
	end if
end showStep2

-- Step 2b: Load Web Agents Extension (REQUIRED)
on showStep2b()
	set step2bResult to display dialog "Step 3 of 5: Load Web Agents Extension

Now load the Web Agents API extension the same way:

  1. Click 'Load unpacked' again
  2. Navigate to and select:
     " & webAgentsExtensionDir & "

This extension provides the window.ai and window.agent APIs to web pages.

Click 'I Loaded It' when done, or 'Show in Finder' to open the folder." buttons {"Show in Finder", "I Loaded It"} default button "I Loaded It" with title "Harbor Setup - Step 3" with icon note
	
	if button returned of step2bResult is "Show in Finder" then
		do shell script "open '" & webAgentsExtensionDir & "'"
		-- Show this step again
		showStep2b()
	else
		showStep3()
	end if
end showStep2b

-- Step 3: Get Extension IDs
on showStep3()
	set step3Result to display dialog "Step 4 of 5: Copy Harbor Extension ID

In Chrome (chrome://extensions):
  1. Find 'Harbor' in the list
  2. Copy the 32-character ID shown below the name
     (looks like: abcdefghijklmnopabcdefghijklmnop)

Paste the Harbor extension ID below:" default answer "" buttons {"Back", "Next"} default button "Next" cancel button "Back" with title "Harbor Setup - Step 4" with icon note
	
	if button returned of step3Result is "Next" then
		set harborExtId to text returned of step3Result
		
		-- Validate ID format
		if length of harborExtId is not 32 then
			display dialog "That doesn't look like a valid extension ID.

Extension IDs are exactly 32 characters long and contain only lowercase letters a-p.

Example: abcdefghijklmnopabcdefghijklmnop" buttons {"Try Again"} default button "Try Again" with title "Invalid Extension ID" with icon caution
			showStep3()
			return
		end if
		
		-- Ask for Web Agents extension ID (REQUIRED)
		showStep3b(harborExtId)
	else
		showStep2b()
	end if
end showStep3

-- Step 3b: Get Web Agents Extension ID (REQUIRED)
on showStep3b(harborExtId)
	set step3bResult to display dialog "Step 5 of 5: Copy Web Agents Extension ID

Now copy the Web Agents extension ID:
  1. Find 'Web Agents' in chrome://extensions
  2. Copy the 32-character ID shown below the name

Paste the Web Agents extension ID below:" default answer "" buttons {"Back", "Configure"} default button "Configure" cancel button "Back" with title "Harbor Setup - Step 5" with icon note
	
	if button returned of step3bResult is "Configure" then
		set webAgentsExtId to text returned of step3bResult
		
		-- Validate ID format
		if length of webAgentsExtId is not 32 then
			display dialog "That doesn't look like a valid extension ID.

Extension IDs are exactly 32 characters long and contain only lowercase letters a-p.

Example: abcdefghijklmnopabcdefghijklmnop" buttons {"Try Again"} default button "Try Again" with title "Invalid Extension ID" with icon caution
			showStep3b(harborExtId)
			return
		end if
		
		-- Configure the extension IDs
		configureExtensionIds(harborExtId, webAgentsExtId)
	else
		showStep3()
	end if
end showStep3b

-- Configure extension IDs in native messaging manifests
on configureExtensionIds(harborId, webAgentsId)
	-- Build the allowed_origins JSON array
	set originsJson to "[\"chrome-extension://" & harborId & "/\""
	if webAgentsId is not "" and length of webAgentsId is 32 then
		set originsJson to originsJson & ", \"chrome-extension://" & webAgentsId & "/\""
	end if
	set originsJson to originsJson & "]"
	
	-- List of manifest locations to update
	set manifestLocations to {¬
		"/Library/Application Support/Google/Chrome/NativeMessagingHosts/harbor_bridge.json", ¬
		"/Library/Application Support/Chromium/NativeMessagingHosts/harbor_bridge.json", ¬
		"/Library/Application Support/Microsoft Edge/NativeMessagingHosts/harbor_bridge.json", ¬
		"/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/harbor_bridge.json", ¬
		"/Library/Application Support/Arc/User Data/NativeMessagingHosts/harbor_bridge.json", ¬
		"/Library/Application Support/Vivaldi/NativeMessagingHosts/harbor_bridge.json"}
	
	-- Also check user-level Chrome manifest
	set userHome to do shell script "echo $HOME"
	set userChromeManifest to userHome & "/Library/Application Support/Google/Chrome/NativeMessagingHosts/harbor_bridge.json"
	
	set updatedCount to 0
	set errorMessages to ""
	
	-- Update each manifest file
	repeat with manifestPath in manifestLocations
		if fileExists(manifestPath) then
			try
				updateManifestFile(manifestPath, originsJson)
				set updatedCount to updatedCount + 1
			on error errMsg
				set errorMessages to errorMessages & manifestPath & ": " & errMsg & return
			end try
		end if
	end repeat
	
	-- Also update user-level manifest
	if fileExists(userChromeManifest) then
		try
			updateManifestFile(userChromeManifest, originsJson)
			set updatedCount to updatedCount + 1
		end try
	end if
	
	-- Save extension IDs for future reference
	try
		set configDir to userHome & "/.harbor"
		do shell script "mkdir -p '" & configDir & "'"
		set configContent to "CHROME_EXTENSION_ID=\"" & harborId & "\"" & return
		if webAgentsId is not "" then
			set configContent to configContent & "CHROME_WEB_AGENTS_EXTENSION_ID=\"" & webAgentsId & "\"" & return
		end if
		do shell script "echo " & quoted form of configContent & " > '" & configDir & "/extension-ids.env'"
	end try
	
	showStep4(updatedCount, harborId)
end configureExtensionIds

-- Update a manifest file with new allowed_origins
on updateManifestFile(manifestPath, originsJson)
	-- Use Python for reliable JSON manipulation
	set pythonScript to "
import json
import sys

manifest_path = sys.argv[1]
origins = json.loads(sys.argv[2])

with open(manifest_path, 'r') as f:
    data = json.load(f)

data['allowed_origins'] = origins

with open(manifest_path, 'w') as f:
    json.dump(data, f, indent=2)
"
	
	do shell script "python3 -c " & quoted form of pythonScript & " " & quoted form of manifestPath & " " & quoted form of originsJson with administrator privileges
end updateManifestFile

-- Step 4: Done!
on showStep4(updatedCount, extId)
	set successMsg to "Setup Complete! ✅

Harbor and Web Agents are now configured.

Updated " & updatedCount & " native messaging manifest(s).

Next steps:
  • Restart Chrome for changes to take effect
  • Click the Harbor icon (⚓) in Chrome's toolbar
  • Open the side panel to start using Harbor!
  • Visit demo pages to test the Web Agents API"
	
	set doneResult to display dialog successMsg buttons {"Restart Chrome", "Done"} default button "Done" with title "Harbor Setup Complete" with icon note
	
	if button returned of doneResult is "Restart Chrome" then
		-- Quit and relaunch Chrome
		try
			tell application "Google Chrome" to quit
			delay 2
			do shell script "open -a 'Google Chrome'"
		end try
	end if
end showStep4

-- Helper: Check if file or directory exists
on fileExists(thePath)
	try
		do shell script "test -e " & quoted form of thePath
		return true
	on error
		return false
	end try
end fileExists
