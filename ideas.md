# Context Assistant App Engine

- Our app will now run it's own "app engine" server.  When App Engine is enabled:
  - Add a new "App Engine" tab next to the "Editor" tab in the top frame when app engine is enabled.  This will hold the GUI to control our app entine.
  - Create and launch context-assistant reverse proxy docker container in the selected docker context (local or remote).  This is where we will configure routes and static file storage in our app engine.  It will also be used for proxy caching.  Add proxy status of all deployed apps to App Engine tab view.
  - The app engine will store static files scoped to each app (each published app base URL will have a determinalistic path in static file storage, like an app API key in the URL).  We then will then have an app enabled/disabled setting that will configure the reverse proxy to serve the app at it's public path. 
  - The app engine will host multiple sqlite db's scoped to each app (so each app can have a prod, dev, staging etc.. environments and datasources that are available to the apps serverless functions, not public)
  - the app engine will allow creating serverless functions (like "lambda" or "cloud function") for app backend services.  These functions will be writen in typescript and run with bun in their own thread.  Function execution will have logging for observability, with execution metrics and process logging.
   - the app engine will allow creating endpoints for http methods to run serverless functions that respond with HTTP and JSON.
   - The app engine will allow creating cron jobs to run serverless function
   - the app engine will allow creating events that trigger serverless functions
     - app started
     - app stopped
     - app published
     - app unpublished
     - app deleted
   - The app engine will have a concept of publish "environments" where we can specify an environment name and environment variables that will be added to the app serverless function calling argumetns
- We will add an "App Engine" settings section where we can enable/disable app engine globally.  This is alwo where we list all configured app engine apps with management drop down menu ("Start/Stop App", "Run Tests", "Publish/Unpublish App", "Open", "Delete")