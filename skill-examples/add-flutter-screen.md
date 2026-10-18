# Skill: when adding a Flutter screen in this app
Copy this file to `.akosua/skills/add-flutter-screen.md` in your project and adapt the specifics.

1. Look at the nearest existing screen first: replicate its folder layout, Riverpod provider style (Notifier/AsyncNotifier/FutureProvider as used by siblings), and routing registration.
2. State: providers beside the feature, never in `main.dart`. Generated code (riverpod_generator/freezed if used by siblings) — run build_runner the way the repo does, don't hand-write `.g.dart`.
3. UI: reuse theme/colors/text styles from the app theme; no one-off constants. Loading/error/empty states are mandatory — copy the pattern from a sibling screen.
4. Data: go through the existing repository/API layer; never call HTTP from a widget. DTO changes ripple to the backend contract — flag them.
5. Verify: `flutter analyze` on the feature + the app's test command; report PASS/FAIL/COULD-NOT-RUN honestly.
