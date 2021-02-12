cse_data_tool.html: cse_data_tool_html_top.html cse_data_tool.js cse_data_tool_html_script_to_css.html cse_data_tool.css cse_data_tool_html_main_content.html default_json_map.json cse_data_tool_html_main_bottom.html
	cat $^ > $@
