# Feature flags

```ts
if (condition) {
	newBehavior();
} else {
	oldBehavior();
}
```

## Emulate staging

Add a second domain that points to the production app, e.g., `staging.app.example.com` and in the code use a feature flag called STAGING that is enabled depending on the domain from which the app is running in.

## Early access program

A checkbox in the users profile and a feature flag in the code that relies on this checkbox. Can make it public so users can enable it themselves or keep it private so only our team can control it.

## Experimental features

`chrome://flags/`

Allow users to select the features they want to enable. When the developers think a new feature is already stable enough, they can turn it on by default. And even after that there could remain a checkbox for turning it off.

## Release flags

Instead of pushing a code update that turns the feature on and off, we do it with a release flag somewhere in the internal admin interface.

## Canary deployments

Watch production metrics as you ramp rollout percentage to users. If you see worrying anomalies roll back and investigate.

## Dark launch

Send a copy of all traffic requests to the new service version. Responses from the new service are ignored but allows you to test performance metrics.
