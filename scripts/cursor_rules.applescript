-- 只使用 Cursor 自身 User Rules 界面，不读写账号、认证或状态数据库。
property ruleRows : {}
property editorArea : missing value
property editorCancel : missing value
on elementsOf(w)
 tell application "System Events" to tell process "Cursor" to return entire contents of w
end elementsOf
on namedButton(w, labelText)
 set es to my elementsOf(w)
 tell application "System Events"
  repeat with e in es
   try
    if role of e is "AXButton" and name of e is labelText then return contents of e
   end try
  end repeat
 end tell
 return missing value
end namedButton
on ruleWindow()
 tell application "System Events"
  if not (exists process "Cursor") then error "Cursor 未运行；打开后重新检查。"
  tell process "Cursor"
   repeat with w in windows
    if name of w is "Cursor Agents" then return contents of w
   end repeat
  end tell
 end tell
 error "请先打开 Cursor Agents 窗口后重新同步。"
end ruleWindow
on rulesTexts(w)
 set resultTexts to {}
 set ruleRows to {}
 set es to my elementsOf(w)
 tell application "System Events"
  repeat with e in es
   try
    if role of e is "AXStaticText" and name of e is "User Rule" then
     set p to value of attribute "AXParent" of e
     set kids to entire contents of p
     repeat with k in kids
      if role of k is "AXStaticText" and name of k is not "User Rule" then
       set end of resultTexts to name of k as text
       set end of ruleRows to p
       exit repeat
      end if
     end repeat
    end if
   end try
  end repeat
 end tell
 return resultTexts
end rulesTexts
on fullRule(w, summaryText)
 set rowButton to missing value
 tell application "System Events"
  repeat with rowRef in ruleRows
   try
    set kids to entire contents of rowRef
    repeat with k in kids
     if role of k is "AXStaticText" and name of k is summaryText then
      set rowButton to contents of rowRef
      exit repeat
     end if
    end repeat
    if rowButton is not missing value then exit repeat
   end try
  end repeat
 end tell
 if rowButton is missing value then error "规则列表发生变化，请重新检查。"
 tell application "System Events" to click rowButton
 set sourceText to missing value
 delay 0.15
 if editorArea is not missing value then
  try
   tell application "System Events" to set sourceText to value of editorArea as text
  end try
 end if
 repeat 30 times
  if sourceText is not missing value then exit repeat
  delay 0.1
  set es to my elementsOf(w)
  tell application "System Events"
   repeat with e in es
    try
     if role of e is "AXTextArea" then
      set editorArea to contents of e
      set sourceText to value of e as text
     end if
    end try
   end repeat
  end tell
  if sourceText is not missing value then exit repeat
 end repeat
 if editorCancel is missing value then set editorCancel to my namedButton(w, "Cancel")
 if editorCancel is not missing value then tell application "System Events" to click editorCancel
 if sourceText is missing value then error "无法读取规则完整正文。"
 return sourceText
end fullRule
on run argv
 set actionName to item 1 of argv
 tell application "Cursor" to activate
 delay 0.4
 set w to my ruleWindow()
 log "hub:window"
 if my namedButton(w, "Save") is not missing value and my namedButton(w, "Cancel") is not missing value then error "Cursor 正在编辑内容，请保存或取消后同步。"
 set b to my namedButton(w, "Customize")
 if b is missing value then error "未找到 Cursor Customize 入口。"
 tell application "System Events" to click b
 log "hub:customize"
 repeat 30 times
  delay 0.1
  set b to my namedButton(w, "Rules")
  if b is not missing value then exit repeat
 end repeat
 if b is missing value then error "未找到 Cursor Rules 页面。"
 tell application "System Events" to click b
 delay 0.4
 log "hub:rules"
 set texts to my rulesTexts(w)
 log "hub:list"
 if actionName is "get" then
  return my fullRule(w, item 4 of argv)
 end if
 if actionName is "list" then
  if my namedButton(w, "New") is missing value then error "Cursor Rules 页面未就绪。"
  set AppleScript's text item delimiters to ASCII character 30
  return texts as text
 end if
 if actionName is "read" then
  if my namedButton(w, "New") is missing value then error "Cursor Rules 页面未就绪。"
  set fullTexts to {}
  repeat with summaryText in texts
   set end of fullTexts to my fullRule(w, summaryText as text)
  end repeat
  set texts to fullTexts
  set AppleScript's text item delimiters to ASCII character 30
  return texts as text
 end if
 set oldText to read POSIX file (item 2 of argv) as «class utf8»
 set newText to read POSIX file (item 3 of argv) as «class utf8»
 if actionName is "add" then
  set b to my namedButton(w, "New")
  if b is missing value then error "未找到新建规则按钮。"
 else
  set b to missing value
  set es to my elementsOf(w)
  tell application "System Events"
   repeat with e in es
    try
     if role of e is "AXStaticText" and name of e is "User Rule" then
      set p to value of attribute "AXParent" of e
      set kids to entire contents of p
      repeat with k in kids
       if role of k is "AXStaticText" and name of k is (item 4 of argv) then set b to p
      end repeat
     end if
    end try
   end repeat
  end tell
  if b is missing value then error "规则已被外部修改，停止覆盖，请重新检查。"
 end if
 log "hub:edit-found"
 tell application "System Events" to click b
 log "hub:edit-opened"
 set area to missing value
 repeat 30 times
  delay 0.1
  set es to my elementsOf(w)
  tell application "System Events"
   repeat with e in es
    try
     if role of e is "AXTextArea" then set area to contents of e
    end try
   end repeat
  end tell
  if area is not missing value then exit repeat
 end repeat
 if area is missing value then error "未找到规则编辑器。"
 if actionName is not "add" then
  tell application "System Events"
   if value of area is not oldText then
    set cancelButton to my namedButton(w, "Cancel")
    if cancelButton is not missing value then click cancelButton
    error "规则已被外部修改，停止覆盖。"
   end if
  end tell
 end if
 log "hub:editor-ready"
 tell application "System Events" to set value of area to newText
 tell application "System Events"
  if value of area is not newText then error "规则内容写入编辑器后校验失败。"
 end tell
 set b to my namedButton(w, "Save")
 if b is missing value then error "未找到保存按钮。"
 tell application "System Events" to click b
 delay 0.5
 return "saved"
end run
