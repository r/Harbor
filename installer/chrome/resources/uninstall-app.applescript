-- Harbor Chrome Uninstaller App
-- This AppleScript creates a double-clickable uninstaller

on run
    -- Show confirmation dialog
    set dialogResult to display dialog "This will uninstall Harbor from your Mac." & return & return & "The following will be removed:" & return & "• Harbor bridge application" & return & "• Chrome extension files" & return & "• Native messaging configuration" & return & return & "Your personal data (~/.harbor) will be preserved unless you choose to remove it." buttons {"Cancel", "Uninstall"} default button "Cancel" cancel button "Cancel" with title "Uninstall Harbor" with icon caution
    
    if button returned of dialogResult is "Uninstall" then
        -- Ask about user data
        set userDataExists to do shell script "test -d ~/.harbor && echo 'yes' || echo 'no'"
        
        set removeUserData to false
        if userDataExists is "yes" then
            try
                set dataDialog to display dialog "Do you also want to remove your Harbor user data?" & return & return & "This includes:" & return & "• Settings and preferences" & return & "• Installed MCP servers" & return & "• Chat history" & return & return & "Location: ~/.harbor" buttons {"Keep Data", "Remove Data"} default button "Keep Data" with title "User Data" with icon caution
                if button returned of dataDialog is "Remove Data" then
                    set removeUserData to true
                end if
            end try
        end if
        
        -- Run the uninstall script with admin privileges
        try
            if removeUserData then
                do shell script "/Library/Application\\ Support/Harbor/uninstall.sh --force-all" with administrator privileges
            else
                do shell script "/Library/Application\\ Support/Harbor/uninstall.sh --force" with administrator privileges
            end if
            
            -- Show success
            display dialog "Harbor has been uninstalled successfully!" & return & return & "To complete the removal:" & return & "1. Open Chrome" & return & "2. Go to chrome://extensions/" & return & "3. Find 'Harbor' and click Remove" buttons {"OK"} default button "OK" with title "Uninstall Complete" with icon note
            
        on error errMsg
            display dialog "Uninstall failed: " & errMsg buttons {"OK"} default button "OK" with title "Error" with icon stop
        end try
    end if
end run
