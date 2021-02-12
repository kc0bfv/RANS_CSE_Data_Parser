// Window Properties
const REPORT_FILE_ID = "report_file";
const PROJ_CUST_MAP_ID = "proj_cust_map_area";
const CUST_RSGP_MAP_ID = "cust_rsgp_map_area";
const JSON_EXPORT_ID = "json_export";

// Constants about report format
const REPORT_HEADER_LINE = 11;
const EXPECTED_REPORT_HDR = ["Event Number", "Event Name", "Event Start", "Event End", "Event Status", "Resource Name", "Resource Category", "Resource Quantity"];
const REPORT_EV_NAME_COL = 1;
const REPORT_RSC_NAME_COL = 5;
const REPORT_RSC_QUAN_COL = 7;


// Other Constants
const WEIRD_WEEK_COUNT_LOOKUP = {2020: 53, 2026: 53, 2032: 53, 2037: 53, 
        2043: 53, 2048: 53, 2054: 53};
const MAX_WEIRD_WEEK = 2054;
const HTML_SAVE_NAME = "cse_data_tool.html"


// Notes about resolving project names to resource groups
/* Currently customer is not returned in the project.  Resource groups are determined
   by customer, under our current construct, therefore we must resolve a project to a
   customer, then a customer to a resource group, to determine which resource group
   a project should be counted as.  That means the data structures could look like:

   project -> customer map
   customer -> resource group map

   This is what I'll go with for now for simplicity.  It will also let me build out
   some radio box sections that do this specifying...  Changing a radio box will
   cause an update to internal state.  Functions doing data processing will then
   reference internal state.
    */

// Some initial resource group/customer/project mappings
window.CSE_GLOB = {};
window.CSE_GLOB.proj_cust_map = undefined;
window.CSE_GLOB.cust_rsgp_map = undefined;

function on_load() {
    attach_listeners();

    ingest_json();
}

function attach_listeners() {
    const report_file_input = document.getElementById(REPORT_FILE_ID);
    
    report_file_input.addEventListener("change", read_report);
}

function read_report(event) {
    /* Called in response to a click on the report file selector
       Returns nothing - asynchronously passes to handle_report
        */
    const file_list = event.target.files;
    if( file_list.length < 1 ) {
        console.log("User didn't select a file");
        return;
    }

    const file = file_list[0];
    window.f = file;

    const reader = new FileReader();
    reader.addEventListener('load', function(event) {
            const content = parse_quoted_csv(event.target.result);
            
            handle_report(content);
        });

    report_text = reader.readAsText(file);
}

function parse_quoted_csv(content) {
    /* Parse CSV with quoted values
       Return an array of line arrays
        */
    let output = [];
    let cur_line = [];
    let cur_entry = "";
    let inside_quotes = false;

    for( let cur_pos = 0; cur_pos < content.length; cur_pos++ ) {
        if( content[cur_pos] == '"' ) {
            if( inside_quotes ) {
                inside_quotes = false;
                cur_line.push(cur_entry);
                cur_entry = "";
            } else {
                inside_quotes = true;
            }
        } else if( content[cur_pos] == "," && !inside_quotes ) {
            // Nothing needed right now, all things are separated by quotes
        } else if( content[cur_pos] == "\n" && !inside_quotes ) {
            output.push(cur_line);
            cur_line = [];
        } else if( content[cur_pos] == "\r" && !inside_quotes ) {
            // Just ignore Windows line endings...
        } else if( inside_quotes ) {
            cur_entry += content[cur_pos];
        } else {
            console.error("Unexpected text found: '" + content[cur_pos] + "'");
        }
    }

    if( inside_quotes || cur_line.length != 0 || cur_entry != "" ) {
        window.cl = cur_line; window.ce = cur_entry;
        console.error("Invalid end position found: inside_quotes-" + 
            inside_quotes + " cur_line-'" + cur_line + "' cur_entry-'" +
            cur_entry + "'");
    }

    return output;
}

function handle_report(report) {
    /* Process the report content.  Input a report array
        */

    // Update in-memory properties with interface data
    load_maps_into_mem();

    // Validate the report header line
    if( report[REPORT_HEADER_LINE].length != EXPECTED_REPORT_HDR.length ) {
        console.error("Header was unexpected length!  Stopping.");
        return;
    }
    for( let cur_entry = 0; cur_entry < EXPECTED_REPORT_HDR.length; 
            cur_entry++ ) {
        if( report[REPORT_HEADER_LINE][cur_entry] != 
                EXPECTED_REPORT_HDR[cur_entry] ) {
            console.error("Unexpected header entry - stopping: " +
                report[REPORT_HEADER_LINE][cur_entry]);
            return;
        }
    }

    // Pull out only the report data lines
    const report_data = report.slice(REPORT_HEADER_LINE + 1);

    // Get the resource groups - "567 COG", "81 TRW", "OCO", ...
    let resource_groups_initial = get_resource_groups();
    if( resource_groups_initial.length == 0 ) {
        resource_groups_initial = [null];
    }
    const resource_groups = resource_groups_initial;
    // Build the data - an array of resources used by week per resource group
    const resource_usages = resource_groups.map(function(rsc_grp) {
            const rgx = new RegExp(
                    "^(?<type>Planner|Builder)-(?<year>[0-9]{4})-Week(?<weekno>[0-9]+)$");

            // Filter out the hours-weeks-resource lines
            const hrs_dat = report_data.filter(function(line) {
                    return rgx.test(line[REPORT_RSC_NAME_COL]);
                });

            // Filter out only data for this resource group
            const grp_hrs_dat = hrs_dat.filter(function(line) {
                    // Resolve the event name to a resource group then check
                    const event_rsc_grp =
                        resolve_proj_rsc_grp(line[REPORT_EV_NAME_COL]);
                    return event_rsc_grp == rsc_grp;
                });

            // Store the week data
            let week_dat = new Map();
            grp_hrs_dat.forEach(function(line) {
                    // Parse resource info
                    const matched = line[REPORT_RSC_NAME_COL].match(rgx);
                    const wkno = Number(matched.groups["weekno"]);
                    const work_type = matched.groups["type"];

                    const year = Number(matched.groups["year"]);
                    console.log(year, wkno, work_type);

                    // Check for roughly proper format
                    if( wkno < 1 || wkno > 53 ) {
                        console.error("ERROR: Invalid week seen: " + wkno + 
                                " from " + line[REPORT_RSC_NAME_COL]);
                    }

                    // Grab resource count
                    const rsc_cnt = Number(line[REPORT_RSC_QUAN_COL]);

                    // Build a sortable map lookup key
                    const entry_key = gen_std_date_fmt(year, wkno);

                    // Put the hours in the map
                    const prev_val = week_dat.has(entry_key) ? 
                            week_dat.get(entry_key) : 0;
                    week_dat.set(entry_key, prev_val + rsc_cnt);
                });

            return week_dat;
        });

    // Enable this line if you want to see what kinda output we have right now
    debug_output_resource_mapping( resource_groups, resource_usages );

    // Determine the time period covered by the resource data
    let [min_time, max_time] = find_resource_period(resource_usages);

    // Generate an array of all year/week numbers in that time period
    time_point_arr = gen_all_weeks(min_time, max_time);

    // Convert the resources into reports
    resource_reports = resource_usages.map( function(resource_usage) {
            return time_point_arr.map( function(time_pt) {
                // Build the array with the data if present or a 0
                return resource_usage.has(time_pt) ?
                        resource_usage.get(time_pt) : 0;
            });
        });

    // Enable this line if you want to see what kinda output we have right now
    debug_output_resource_reports(resource_groups, resource_reports, time_point_arr );

    // Generate the spreadsheet content rows
    report_spreadsheet = build_spreadsheet(resource_groups, resource_reports,
            time_point_arr);
    console.log(report_spreadsheet);
    // Convert the content into a CSV
    csv_output = build_csv(report_spreadsheet);

    //console.log(csv_output);
    output_file("report.csv", csv_output);
}

function output_file(filename, content) {
    /* Create a file download for a file containing the content */

    let blob = new Blob([content], { type: "text/csv; charset=utf-8" });
    let url = URL.createObjectURL(blob);

    save_url(url, filename);
}

function gen_all_weeks(min_time, max_time) {
    /* Return an array of all weeks in the time period (inclusive
        Assumes that times are numbers of format yyyyww
        */
    const [end_yr, end_wk] = parse_std_date_fmt(max_time);
    let [cur_yr, cur_wk] = parse_std_date_fmt(min_time);

    let retval = new Array();
    while( cur_yr <= end_yr && cur_wk <= end_wk ) {
        retval.push( gen_std_date_fmt(cur_yr, cur_wk) );
        cur_wk += 1;
        if( cur_wk > get_yr_wk_count( cur_yr ) ) {
            cur_wk = 1;
            cur_yr += 1;
        }
        if( cur_yr >= 3000 ) {
            console.error("ERROR: Generating weeks is out of bounds.")
        }
    }

    return retval;
}

function find_resource_period(resource_usages) {
    /* Return the min and max time periods seen in the keys of
        resource_usages data.  The keys must be numbers, and they must
        be in a format such that sorting them does indeed produce the
        right order.  e.g. - yyyyww
        */
    let seen_time_points = new Set();

    resource_usages.forEach( function(rsrc_grp_use) {
        rsrc_grp_use.forEach( function(rsrc_cnt, date_repr) {
            seen_time_points.add(date_repr);
        });
    });

    const min = Math.min(...seen_time_points);
    const max = Math.max(...seen_time_points);
    return [min, max]
}

function gen_std_date_fmt(year, week_no) {
    // Build a sortable date of format yyyyww (where ww is week number)
    return year * 100 + week_no;
}

function parse_std_date_fmt(date) {
    // Take a date Number in yyyyww format and return [year, week_number]
    const yr = Math.floor(date / 100);
    const wk = date % 100;
    return [yr, wk]
}

function debug_output_resource_mapping(resource_groups, resource_usages) {
    // Map the resource group names to their resources
    const resource_zip = resource_groups.map( function(grp_nm, ind) {
            return [grp_nm, resource_usages[ind]];
        });
    const resource_usage_zip = new Map(resource_zip);

    console.log("Resource group and usage mapping: ");
    for( let entry of resource_usage_zip ) {
        console.log("Group: " + entry[0]);
        console.log(entry[1]);
    }
}

function debug_output_resource_reports( resource_groups, resource_reports,
        time_point_arr ) {
    // Map the resource group names to their resources
    const resource_zip = resource_groups.map( function(grp_nm, ind) {
            return [grp_nm, resource_reports[ind]];
        });
    const resource_usages = new Map(resource_zip);

    console.log("Resource group and report mapping: ");
    for( let entry of resource_usages ) {
        console.log("Group: " + entry[0]);
        console.log("Data: ");
        console.log(entry[1]);
        console.log("Time points: ");
        console.log(time_point_arr);
    }
}

function build_spreadsheet( resource_groups, resource_reports, time_point_arr ) {
    /* Build an array of arrays representing the output spreadsheet */
    let retval = new Array();

    let header_row = ["Customer Group"];
    time_point_arr.forEach( function(time_pt) {
            header_row.push(time_pt);
        });

    retval.push(header_row);

    resource_groups.forEach( function(grp_nm, ind) {
            const currow = [grp_nm].concat( resource_reports[ind] );
            retval.push(currow);
        });

    return retval;
}

function build_csv(spreadsheet) {
    /* Build a CSV out of a spreadsheet
        WARNING: this will not escape quotes.  It trusts the input not to have " in it
        */
    const csv_rows = spreadsheet.map( function(row) {
            const quoted_row = row.map( function(ent) {
                    return '"' + ent + '"';
                });
            return quoted_row.join(",");
        });
    return csv_rows.join("\n");
}

function get_yr_wk_count( year_num ) {
    /* Return the number of weeks in a year */
    if( year_num > MAX_WEIRD_WEEK ) {
        console.error("WEIRD_WEEK_COUNT_LOOKUP does not contain enough data " +
            "for year: " + year_num);
    }
    return year_num in WEIRD_WEEK_COUNT_LOOKUP ? 
            WEIRD_WEEK_COUNT_LOOKUP[year_num] : 52;
}

function get_resource_groups() {
    /* References the in-memory mapping, returns a list of all resource groups
        */
 
    let retval = new Set(window.CSE_GLOB.cust_rsgp_map.values());
    return Array.from(retval);
}

function resolve_proj_rsc_grp(proj_name) {
    /* Resolve a project into a resource group
        */
    const cust_name = resolve_proj_cust(proj_name);
    const rsgp_name = window.CSE_GLOB.cust_rsgp_map.get(cust_name);
    if( rsgp_name === undefined && cust_name !== undefined ) {
        const err_message = "No mapping for customer: " + cust_name;
        console.error(err_message);
        alert(err_message + "\nYou'll want to try this again...");
    }

    return rsgp_name;
}

function resolve_proj_cust(proj_name) {
    /* Resolve a project into a customer
        */
    const cust_name = window.CSE_GLOB.proj_cust_map.get(proj_name);
    if( cust_name === undefined ) {
        const err_message = "No mapping for project: " + proj_name;
        console.error(err_message);
        alert(err_message + "\nYou'll want to try this again...");

        add_project_to_interface(proj_name);
    }

    return cust_name;
}



// Managing the Interface

function load_proj_cust_map() {
    /* Load the project/customer map into memory from the interface
        */

    const map_elem = document.getElementById(PROJ_CUST_MAP_ID).childNodes[0];
    const form_elems = Array.from(map_elem.childNodes).filter( function(elem) {
            return elem.tagName == "FORM";
        });

    window.CSE_GLOB.proj_cust_map = new Map(form_elems.map( function(elem) {
            const form_for = elem.getAttribute("form_for");
            const selected = elem.rb.value;
            return [form_for, selected];
        }));
}

function load_cust_rsgp_map() {
    /* Load the customer/resource group map into memory from the interface
        */

    const map_elem = document.getElementById(CUST_RSGP_MAP_ID).childNodes[0];
    const form_elems = Array.from(map_elem.childNodes).filter( function(elem) {
            return elem.tagName == "FORM";
        });

    window.CSE_GLOB.cust_rsgp_map = new Map(form_elems.map( function(elem) {
            const form_for = elem.getAttribute("form_for");
            const selected = elem.rb.value;
            return [form_for, selected];
        }));
}

function load_maps_into_mem() {
    load_proj_cust_map();
    load_cust_rsgp_map();
}

// For saving the proj / cust mappings, onto the interface, use "rebuild" funcs

function ensure_known_projs_defined() {
    if( window.CSE_GLOB.known_projs === undefined ) {
        window.CSE_GLOB.known_projs = new Set(window.CSE_GLOB.proj_cust_map.keys());
    }
}

function ensure_known_custs_defined() {
    if( window.CSE_GLOB.known_custs === undefined ) {
        window.CSE_GLOB.known_custs = new Set(window.CSE_GLOB.proj_cust_map.values());
    }
}

function ensure_known_rsgps_defined() {
    if( window.CSE_GLOB.known_rsgps === undefined ) {
        window.CSE_GLOB.known_rsgps = new Set(window.CSE_GLOB.cust_rsgp_map.values());
    }
}

function ensure_knowns_defined() {
    ensure_known_projs_defined();
    ensure_known_custs_defined();
    ensure_known_rsgps_defined();
}

function reset_known_proj_cust_rsgp() {
    /* Reset the known projects, customers, and resource groups, so they can
       be redefined
        */
    window.CSE_GLOB.known_projs = undefined;
    window.CSE_GLOB.known_custs = undefined;
    window.CSE_GLOB.known_rsgps = undefined;
}

function add_project_to_interface(proj_name) {
    load_maps_into_mem();
    ensure_knowns_defined();

    if( Array.from( window.CSE_GLOB.known_custs ).length === 0 ) {
        add_customer_to_interface();
    }

    if( proj_name === undefined ) {
        proj_name = prompt("New project name? ");
        if( proj_name === null ) {
            return;
        }
    }
    window.CSE_GLOB.known_projs.add(proj_name);

    build_proj_cust_rsgp_map_interface();
}

function add_customer_to_interface() {
    load_maps_into_mem();
    ensure_knowns_defined();

    if( Array.from( window.CSE_GLOB.known_rsgps ).length === 0 ) {
        add_rsgp_to_interface();
    }

    const cust_name = prompt("New customer name? ");
    if( cust_name === null ) {
        return;
    }
    window.CSE_GLOB.known_custs.add(cust_name);

    build_proj_cust_rsgp_map_interface();
}

function add_rsgp_to_interface() {
    load_maps_into_mem();
    ensure_knowns_defined();

    const rsgp_name = prompt("New resource group name? ");
    if( rsgp_name === null ) {
        return;
    }
    window.CSE_GLOB.known_rsgps.add(rsgp_name);

    build_proj_cust_rsgp_map_interface();
}

function build_proj_cust_rsgp_map_interface() {
    /* Build out the project/customer and customer/resource group map interface
        */

    rebuild_proj_cust_map();
    rebuild_cust_rsgp_map();
}

function rebuild_proj_cust_map() {
    // First time we run this, before manually adding any customers and projects, we
    // must define these globals
    ensure_knowns_defined();

    // Build the input forms
    const projs = window.CSE_GLOB.known_projs;
    const custs = window.CSE_GLOB.known_custs;
    const button_forms = Array.from(projs).map( function(proj) {
            const cur_sel = window.CSE_GLOB.proj_cust_map.get(proj);
            return build_radio_button_list("proj_cust_map", proj, custs, cur_sel);
        });

    // Put them on the interface
    build_map_intfc(PROJ_CUST_MAP_ID, "Project / Customer Mapping", button_forms);

}

function rebuild_cust_rsgp_map() {
    // First time we run this, before manually adding any customers and projects, we
    // must define these globals
    ensure_knowns_defined();

    // Build the input forms
    const custs = window.CSE_GLOB.known_custs;
    const rsgps = window.CSE_GLOB.known_rsgps;
    const button_forms = Array.from(custs).map( function(cust) {
            const cur_sel = window.CSE_GLOB.cust_rsgp_map.get(cust);
            return build_radio_button_list("cust_rsgp_map", cust, rsgps, cur_sel);
        });

    // Put them on the interface
    build_map_intfc(CUST_RSGP_MAP_ID, "Customer / Resource Group Mapping", button_forms);
}

function build_map_intfc(parent_id, summary, forms) {
    const area_parent = document.getElementById(parent_id);

    const area_details = document.createElement("details")
    const area_label = document.createElement("summary");

    area_label.appendChild(document.createTextNode(summary));
    area_details.appendChild(area_label);

    forms.forEach( function(form) {
            area_details.appendChild(form);
        });

    area_parent.innerHTML = "";
    area_parent.appendChild(area_details);
}

function build_radio_button_list(name_prefix, form_name, entries, selected) {
    const check_boxes = Array.from(entries).map( function(entry) {
            let label = document.createElement("label");
            let text = document.createTextNode(entry);
            let rb = document.createElement("input");
            rb.setAttribute("type", "radio");
            rb.setAttribute("value", entry);
            rb.setAttribute("name", "rb");
            if( entry == selected ) {
                rb.setAttribute("checked", "checked");
            }
            label.appendChild(text);
            label.appendChild(rb);
            return label;
        });
    let form = document.createElement("form");
    let form_label = document.createElement("label");
    let form_ltext = document.createTextNode(form_name);
    form.setAttribute("name", name_prefix + form_name);
    form.setAttribute("form_for", form_name);
    form.classList.add("map_form");
    form_label.appendChild(form_ltext);
    form_label.classList.add("map_form_title");
    form.appendChild(form_label);
    check_boxes.forEach( function(cb) {
            form.appendChild(cb);
        });

    return form;
}


function save_mappings() {
    // Save the in-memory properties to the JSON Export
    dump_maps_to_json();

    let content = document.getElementsByTagName("html")[0].outerHTML;
    let blob = new Blob([content], { type: "text/html; charset=utf-8" });
    let url = URL.createObjectURL(blob);
    save_url(url, HTML_SAVE_NAME);
}

function save_url(url, download_name) {
    let anchor = document.createElement("a")
    anchor.href = url;
    anchor.download = download_name;

    let click = document.createEvent("MouseEvents");
    click.initMouseEvent("click", true, false, window, 0, 0, 0, 0, 0, false, false, false, false, 0, null);

    anchor.dispatchEvent(click);
}

function dump_maps_to_json() {
    /*  Dump the in-memory maps into the JSON export area
        */
    // Update in-memory properties with interface data
    load_maps_into_mem();

    const json_elem = document.getElementById(JSON_EXPORT_ID);
    const json_obj = {
        "proj_cust_map": Object.fromEntries(window.CSE_GLOB.proj_cust_map),
        "cust_rsgp_map": Object.fromEntries(window.CSE_GLOB.cust_rsgp_map),
        };

    const json_out = JSON.stringify(json_obj, null, 2);
    json_elem.innerHTML = json_out;
    json_elem.value = json_out;
}

function ingest_json() {
    /*  Read the JSON export area into the in-memory maps
        */
    const json_elem = document.getElementById(JSON_EXPORT_ID);
    const json_in = json_elem.value;

    // Parse the JSON before overwriting the innerHTML...  Make sure it parses
    const json_obj = JSON.parse(json_in);

    window.CSE_GLOB.proj_cust_map = new Map(Object.entries(
            json_obj["proj_cust_map"] ));
    window.CSE_GLOB.cust_rsgp_map = new Map(Object.entries(
            json_obj["cust_rsgp_map"] ));

    reset_known_proj_cust_rsgp();
    rebuild_proj_cust_map();
    rebuild_cust_rsgp_map();

    json_elem.innerHTML = json_in;
}
