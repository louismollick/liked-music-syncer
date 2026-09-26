# Reconcile the Desired Library instead of running sync jobs

The app computes the Desired Library from Liked Music Libraries and Favorite Artist catalogs, compares it with the Library and the Remote Library, and runs small idempotent Track Steps to close the difference. Progress is saved after each step, so work resumes after a quit and a retry re-runs only the failed step. This replaces separate Liked Songs Sync, catalog refresh, reprocess, retry, and copy-to-remote jobs, which each duplicated the download, tag, and upload pipeline. Users see Activity per track, not a history of jobs.
