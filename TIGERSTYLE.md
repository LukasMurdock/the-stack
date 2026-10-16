# TigerStyle for TypeScript

## The Essence of Style

Style is design.

Our design goals, in order, are:

1. **Safety**
2. **Performance**
3. **Developer experience**

Readability matters because it supports these goals. Consistency matters because it reduces the number of decisions a programmer and reviewer must make.

The goal is not clever TypeScript. The goal is TypeScript whose behavior can be understood, bounded, tested, and operated with confidence.

Prefer code that makes incorrect states difficult to represent and incorrect behavior difficult to hide.

---

# Simplicity

Simplicity is not the first implementation that works.

Simplicity is what remains after the unnecessary states, branches, abstractions, dependencies, allocations, and concepts have been removed.

Before implementing something substantial:

- Identify the invariants.
- Identify failure modes.
- Identify upper bounds.
- Sketch the data flow.
- Sketch resource usage.
- Decide which component owns each piece of mutable state.
- Decide how errors cross boundaries.
- Decide where asynchronous suspension may occur.

Spend thought before spending code.

Do not knowingly ship a design defect merely because it can be fixed later. Code becomes more expensive to change after callers, persistent data, APIs, and operational assumptions depend on it.

---

# Safety

## Prefer explicit control flow

Use straightforward `if`, `switch`, and `for` statements.

Avoid clever expressions when ordinary control flow describes the behavior more clearly.

Prefer:

```ts
if (account.status === "active") {
	processAccount(account);
} else {
	assertAccountInactive(account);
}
```

over:

```ts
account.status === "active"
	? processAccount(account)
	: assertAccountInactive(account);
```

Control flow should be easy to inspect.

Avoid recursion when the amount of work depends on external or untrusted input. Prefer an explicit work list with an explicit limit.

---

## Bound everything

Anything that can grow should have a limit.

This includes:

- request bodies;
- arrays populated from external input;
- database query results;
- queues;
- caches;
- retries;
- concurrency;
- pagination;
- recursion depth;
- log payloads;
- batch sizes;
- message sizes;
- uploaded files;
- buffered streams;
- time spent waiting for external systems.

Do not write:

```ts
const users = await database.query("SELECT * FROM users");
```

when the result can grow without bound.

Prefer an explicit bound:

```ts
const users = await database.listUsers({
	limit: USERS_BATCH_MAX,
});
```

Do not launch one promise per item for an unbounded collection:

```ts
await Promise.all(items.map(processItem));
```

unless `items.length` itself is known and asserted to be bounded.

Bounds are part of the design, not merely defensive validation.

Name important bounds:

```ts
const REQUEST_BODY_BYTES_MAX = 1_048_576;
const RETRY_COUNT_MAX = 3;
const CONCURRENT_REQUESTS_MAX = 32;
```

Do not scatter unexplained numerical limits throughout the code.

---

## TypeScript is not runtime validation

TypeScript types disappear at runtime.

Anything coming from outside the trusted program boundary starts as `unknown`, regardless of what an SDK, HTTP client, database driver, environment variable, JSON parser, or type declaration claims.

Treat these as boundaries:

- HTTP requests;
- API responses;
- JSON;
- environment variables;
- database rows;
- message queues;
- files;
- command-line arguments;
- browser storage;
- IPC;
- user-controlled configuration.

Prefer:

```ts
function parsePort(value: unknown): number {
	if (typeof value !== "string") {
		throw new Error("PORT must be a string");
	}

	const port = Number(value);

	if (!Number.isInteger(port)) {
		throw new Error("PORT must be an integer");
	}

	if (port < 1) {
		throw new Error("PORT must be positive");
	}

	if (port > 65_535) {
		throw new Error("PORT exceeds the maximum TCP port");
	}

	return port;
}
```

Parse external data into trusted domain types once.

The rest of the program should operate on the parsed representation rather than repeatedly questioning whether the input is valid.

---

## Use strict TypeScript

New codebases should use strict compiler settings.

A good baseline is:

```json
{
	"compilerOptions": {
		"strict": true,
		"exactOptionalPropertyTypes": true,
		"noUncheckedIndexedAccess": true,
		"noImplicitOverride": true,
		"noFallthroughCasesInSwitch": true,
		"noImplicitReturns": true,
		"useUnknownInCatchVariables": true
	}
}
```

Do not weaken compiler settings to make an error disappear without understanding why the compiler is objecting.

Compiler errors are design feedback.

---

## Avoid `any`

`any` removes the compiler precisely where additional scrutiny is usually needed.

Prefer `unknown` at dynamic boundaries and narrow it deliberately.

Avoid:

```ts
function parseMessage(message: any): Message {
	return message;
}
```

Prefer:

```ts
function parseMessage(value: unknown): Message {
	// Validate and construct Message.
}
```

When `any` is genuinely necessary to interact with an unsafe library boundary, isolate it in the smallest possible adapter and expose a safe typed interface to the rest of the program.

---

## Avoid type assertions

Treat `as SomeType` as an escape hatch.

It tells the compiler that the programmer knows something the compiler does not. Sometimes this is true. Often it merely hides an incorrect assumption.

Avoid:

```ts
const user = response.body as User;
```

Parse instead:

```ts
const user = parseUser(response.body);
```

Avoid non-null assertions:

```ts
users.get(userId)!.name;
```

Prefer making the missing case explicit:

```ts
const user = users.get(userId);

if (user === undefined) {
	throw new Error(`Unknown user: ${userId}`);
}

return user.name;
```

Use `satisfies` when the goal is checking rather than coercion:

```ts
const config = {
	retries: 3,
	timeoutMs: 5_000,
} satisfies ClientConfig;
```

---

## Make invalid states difficult to represent

Do not model mutually exclusive states as independent booleans.

Avoid:

```ts
type Request = {
	isLoading: boolean;
	isSuccessful: boolean;
	hasFailed: boolean;
};
```

This represents impossible states.

Prefer:

```ts
type RequestState =
	| { kind: "idle" }
	| { kind: "loading" }
	| { kind: "success"; value: Response }
	| { kind: "failure"; error: RequestError };
```

Use discriminated unions for protocols, state machines, commands, events, and domain results.

Make switches exhaustive:

```ts
function renderState(state: RequestState): string {
	switch (state.kind) {
		case "idle":
			return "Idle";

		case "loading":
			return "Loading";

		case "success":
			return state.value.message;

		case "failure":
			return state.error.message;

		default:
			return assertNever(state);
	}
}

function assertNever(value: never): never {
	throw new Error(`Unexpected value: ${String(value)}`);
}
```

Adding a new state should make incomplete consumers fail at compile time.

---

## Assertions are for programmer errors

Distinguish between:

**Expected operating conditions**

- invalid user input;
- authentication failure;
- timeout;
- missing record;
- rate limit;
- unavailable dependency;
- malformed external request.

and:

**Programmer errors**

- impossible state;
- violated invariant;
- incorrect internal length;
- unexpected enum variant;
- corrupted internal relationship;
- logic claiming contradictory facts.

Expected errors must be handled.

Programmer errors should fail loudly.

Use assertions to encode invariants:

```ts
function assert(condition: unknown, message: string): asserts condition {
	if (!condition) {
		throw new Error(`Invariant violated: ${message}`);
	}
}
```

Then:

```ts
assert(offset >= 0, "offset must be non-negative");
assert(offset <= buffer.length, "offset must fit in buffer");
```

Prefer separate assertions:

```ts
assert(index >= 0, "index must be non-negative");
assert(index < items.length, "index must be within items");
```

over:

```ts
assert(index >= 0 && index < items.length, "invalid index");
```

Separate assertions provide better diagnostics and force each invariant to be considered independently.

Assert important relationships both when data is produced and when it is consumed.

---

# Errors

Every error must be deliberately handled, translated, propagated, or declared impossible.

Never silently swallow an error:

```ts
try {
	await save();
} catch {
	// Ignore.
}
```

A `catch` block should generally do at least one of these:

- recover;
- retry;
- translate the error;
- add useful context;
- perform necessary cleanup;
- convert an infrastructure failure into a domain result;
- terminate at a process boundary.

Catch values are `unknown` until proven otherwise:

```ts
try {
	await client.send(request);
} catch (error: unknown) {
	if (error instanceof TimeoutError) {
		return { kind: "timeout" };
	}

	throw error;
}
```

Do not catch an error merely to log it and throw it again when a higher layer will also log it. One failure should normally produce one authoritative error report.

For expected domain outcomes, consider an explicit result:

```ts
type CreateUserResult =
	| { kind: "created"; user: User }
	| { kind: "duplicate_email" }
	| { kind: "invalid_name" };
```

This is usually clearer than using exceptions as ordinary branching.

---

# Async Code

Every `await` is a potential interruption point.

State that was true before an `await` may no longer be true afterward if another task, request, callback, worker, or external system can change it.

Avoid reasoning like this:

```ts
assert(job.status === "pending");

await loadDependencies(job);

// The earlier assertion may no longer describe reality.
job.status = "running";
```

Prefer to:

- gather immutable inputs before suspension;
- avoid retaining unnecessary mutable state across `await`;
- re-check external assumptions after suspension;
- perform state transitions atomically where possible;
- separate synchronous invariant-heavy code from asynchronous orchestration.

Keep async control flow high in the call tree.

A useful shape is:

```ts
async function processBatch(batch: Batch): Promise<void> {
	const input = prepareBatch(batch);

	const records = await loadRecords(input.keys);

	const result = computeBatch(input, records);

	await persistBatch(result);
}
```

Here, `prepareBatch()` and `computeBatch()` can remain synchronous and easy to reason about.

Do not make a function `async` merely because it might need asynchronous behavior someday.

---

## Control concurrency explicitly

Concurrency is a resource.

Do not equate asynchronous code with unlimited parallelism.

If 50,000 items arrive, this:

```ts
await Promise.all(items.map(sendEmail));
```

may create 50,000 simultaneous operations.

Instead define the permitted concurrency and batch size as part of the system design.

The same principle applies to:

- database connections;
- outgoing HTTP requests;
- filesystem operations;
- worker jobs;
- browser requests;
- CPU-heavy promises.

---

## Timeouts and cancellation are part of I/O

External operations should not wait forever unless waiting forever is an explicit part of the protocol.

Pass cancellation explicitly where supported:

```ts
await fetch(url, {
	method: "GET",
	signal: abortSignal,
});
```

Make timeout ownership clear. Avoid stacking several invisible timeout mechanisms at different layers.

---

## No floating promises

Every promise must have an owner.

Avoid:

```ts
writeAuditLog(event);
```

when `writeAuditLog()` returns a promise.

Either wait for it:

```ts
await writeAuditLog(event);
```

or explicitly declare fire-and-forget semantics and define error handling:

```ts
void writeAuditLog(event).catch(reportBackgroundFailure);
```

Background work must still have failure semantics, shutdown semantics, and resource bounds.

---

# State

Minimize mutable state.

Prefer immutable values and `readonly` references where they express the design correctly:

```ts
type Config = {
	readonly timeoutMs: number;
	readonly retriesMax: number;
};
```

Do not duplicate the same fact into multiple mutable representations.

Avoid:

```ts
let users: User[] = [];
let userCount = 0;
```

when `userCount` means nothing more than:

```ts
users.length;
```

Duplicated state eventually disagrees.

Calculate values from the authoritative representation unless doing so would violate a measured performance requirement.

---

## Keep state ownership obvious

Every mutable piece of state should have an obvious owner.

Avoid helpers that unexpectedly mutate distant state:

```ts
function calculateNextStep(context: Context): void {
  context.currentStep++;
  context.queue.push(...);
  context.metrics.increment(...);
}
```

Prefer computation that returns the intended change:

```ts
function calculateNextStep(context: Context): NextStep {
	return {
		nextIndex: context.currentStep + 1,
		newTasks: calculateTasks(context),
	};
}
```

Then let the orchestration layer apply it.

Push `if`s up and loops/calculation down.

Centralize control flow and state transitions where practical; keep leaf functions pure.

---

## Minimize variable scope

Declare variables as close as possible to their use.

Prefer:

```ts
if (request.kind === "transfer") {
	const transfer = parseTransfer(request.payload);
	executeTransfer(transfer);
}
```

over calculating `transfer` much earlier and keeping it alive across unrelated code.

The fewer variables simultaneously in scope, the fewer incorrect combinations the programmer must reason about.

Prefer `const`. Use `let` only when reassignment is part of the algorithm.

Never use `var`.

---

# Functions

Functions should do one conceptually coherent piece of work.

A function should generally have:

- few parameters;
- a simple return type;
- explicit invariants;
- substantial cohesive logic;
- minimal hidden mutation.

Keep functions below **70 physical lines**.

The number is intentionally mechanical. When a function exceeds the limit, reconsider its responsibilities.

Do not solve the limit by extracting meaningless helpers.

Prefer splitting along boundaries such as:

- validation;
- parsing;
- calculation;
- persistence;
- side effects;
- state transition;
- serialization.

Keep branching in the orchestration function where possible:

```ts
function execute(command: Command): Result {
	switch (command.kind) {
		case "create":
			return create(command);

		case "update":
			return update(command);

		case "delete":
			return remove(command);

		default:
			return assertNever(command);
	}
}
```

The leaf functions should not need to rediscover the surrounding control flow.

---

# Function Signatures

Prefer smaller-dimensional APIs.

If a function does not need to return anything, return `void`.

Do not return information merely because it might someday be useful.

Avoid boolean parameters:

```ts
loadUser(id, true, false);
```

Their meaning disappears at the call site.

Prefer an options object:

```ts
loadUser(id, {
	includeProfile: true,
	includePermissions: false,
});
```

Use options objects when:

- parameters have the same primitive type;
- parameters could easily be swapped;
- several parameters are optional;
- boolean arguments would otherwise appear;
- `undefined` would be ambiguous.

Keep options explicit at important boundaries.

Prefer:

```ts
await request(url, {
	timeoutMs: 5_000,
	redirectsMax: 3,
});
```

to relying on consequential library defaults.

Defaults can change when dependencies are upgraded. Critical behavior should remain visible in your code.

---

# Naming

Take naming seriously.

Good names encode the domain model.

Use TypeScript's conventional casing:

- `camelCase` for variables and functions;
- `PascalCase` for types, classes, interfaces, and components;
- `UPPER_SNAKE_CASE` for true constants;
- `kebab-case` for filenames unless the framework has a stronger convention.

Do not abbreviate names merely to save characters.

Prefer:

```ts
sourceOffset;
targetOffset;
connectionTimeoutMs;
requestBodyBytesMax;
```

over:

```ts
srcOff;
dstOff;
connTmo;
maxSize;
```

Short names are appropriate only when their meaning is conventionally obvious and extremely local, such as `i` in a tiny numerical loop.

---

## Put units in names

Primitive numbers do not communicate dimensions.

Avoid:

```ts
const timeout = 5;
```

Prefer:

```ts
const timeoutMs = 5_000;
```

Examples:

```ts
durationMs;
timestampUnixMs;
sizeBytes;
memoryBytesMax;
retryCount;
retryCountMax;
batchSize;
batchSizeMax;
index;
offsetBytes;
```

Do not make the reader remember whether a number is seconds, milliseconds, bytes, kibibytes, indexes, counts, or percentages.

---

## Indexes, counts, and sizes are different concepts

Treat these as semantically different even though JavaScript represents them all as `number`.

An index identifies a position:

```ts
const itemIndex = 4;
```

A count describes how many items exist:

```ts
const itemCount = 5;
```

A byte size describes memory or encoded representation:

```ts
const payloadBytes = 1024;
```

Do not casually interchange them.

For important domains, consider branded types:

```ts
declare const millisecondsBrand: unique symbol;

type Milliseconds = number & {
	readonly [millisecondsBrand]: true;
};
```

Use this selectively. A type abstraction should remove more complexity than it creates.

---

# Conditions

Prefer positive conditions.

Prefer:

```ts
if (index < items.length) {
	return items[index];
} else {
	return undefined;
}
```

over starting from the negated invariant:

```ts
if (!(index >= items.length)) {
	return items[index];
}
```

Complex boolean expressions are difficult to verify.

Avoid:

```ts
if (
	user !== undefined &&
	!user.disabled &&
	(user.role === "admin" || user.role === "owner") &&
	organization.active
) {
	// ...
}
```

When each condition matters independently, spell the cases out:

```ts
if (user === undefined) {
	return { kind: "unknown_user" };
}

if (user.disabled) {
	return { kind: "disabled_user" };
}

if (!organization.active) {
	return { kind: "inactive_organization" };
}

const privileged = user.role === "admin" || user.role === "owner";

if (!privileged) {
	return { kind: "forbidden" };
}

return authorize(user);
```

The goal is not fewer lines. The goal is fewer hidden states per line.

---

# Collections

Array access may return nothing.

With unchecked indexing disabled, this bug is easy to write:

```ts
const user = users[index];
return user.name;
```

Treat indexing as a boundary:

```ts
const user = users[index];

if (user === undefined) {
	throw new Error(`Missing user at index ${index}`);
}

return user.name;
```

If an algorithm proves the index valid, encode that proof with a nearby assertion.

Avoid unnecessarily creating intermediate arrays in hot or large-data paths:

```ts
const result = items.filter(predicate).map(transform).filter(otherPredicate);
```

This style is perfectly reasonable for small collections. For large or performance-sensitive collections, a single explicit loop may be clearer, more predictable, and allocate less:

```ts
const result: Output[] = [];

for (const item of items) {
	if (!predicate(item)) {
		continue;
	}

	const output = transform(item);

	if (!otherPredicate(output)) {
		continue;
	}

	result.push(output);
}
```

Do not optimize syntax by ideology. Consider actual scale.

---

# Performance

Think about performance during design, not only after profiling.

Before implementing a performance-sensitive system, estimate:

- network round trips;
- disk reads and writes;
- database queries;
- allocated memory;
- peak retained memory;
- serialized payload sizes;
- CPU work;
- number of objects;
- concurrency;
- expected and worst-case latency.

Be roughly correct before becoming precisely measurable.

Optimize the expensive resources and operations first.

For most TypeScript services this frequently means:

1. network/database round trips;
2. serialization and copying;
3. memory allocation/retention;
4. CPU.

Actual workloads decide the order.

---

## Batch work

Amortize expensive operations.

Prefer:

```ts
await database.insertMany(records);
```

to:

```ts
for (const record of records) {
	await database.insert(record);
}
```

when the semantics permit batching.

The same principle applies to:

- HTTP requests;
- queue publishing;
- logging;
- database reads;
- filesystem calls;
- worker messages.

Batching should still have an explicit maximum batch size.

---

## Avoid accidental quadratic work

Be suspicious whenever:

- a loop contains `find`;
- a loop contains `includes`;
- a loop repeatedly spreads an array;
- a loop repeatedly concatenates strings;
- an array is repeatedly shifted from the front;
- a database query occurs inside another loop.

For example:

```ts
for (const user of users) {
	const permission = permissions.find(
		(candidate) => candidate.userId === user.id
	);

	// ...
}
```

may be quadratic.

Build an index:

```ts
const permissionByUserId = new Map<UserId, Permission>();

for (const permission of permissions) {
	permissionByUserId.set(permission.userId, permission);
}

for (const user of users) {
	const permission = permissionByUserId.get(user.id);

	// ...
}
```

Choose data structures from the expected access pattern rather than convenience alone.

---

## Treat memory as bounded even though JavaScript is garbage-collected

Garbage collection is not unlimited memory.

Large transient allocations can cause:

- latency spikes;
- increased garbage collection;
- process termination;
- container eviction;
- browser instability.

Avoid allowing queues, maps, caches, or arrays to grow forever.

Every cache needs an eviction policy or a provable finite keyspace.

Every producer/consumer pipeline needs backpressure.

Every accumulated result needs a maximum.

Allocation is a resource decision.

---

## Do not fight the JavaScript engine without evidence

Mechanical sympathy matters, but speculative JIT folklore is not a substitute for measurement.

Prefer simple predictable data structures and algorithms first.

For hot paths:

1. establish a representative benchmark;
2. profile;
3. make one change;
4. measure again;
5. preserve the clearer implementation unless the improvement matters.

Do not turn ordinary application code into engine-specific micro-optimizations for negligible gains.

---

# Dependencies

Every dependency has a cost.

Dependencies increase:

- supply-chain exposure;
- install time;
- build complexity;
- bundle size;
- upgrade work;
- transitive dependency count;
- API surface;
- runtime uncertainty;
- maintenance obligations.

Before adding a package, ask:

1. Can the platform already do this?
2. Can we implement the required subset safely in a small amount of code?
3. How many transitive dependencies does this introduce?
4. Is the dependency maintained?
5. Is its API substantially simpler than the underlying problem?
6. Can it affect runtime correctness or security?
7. What happens when we need to upgrade or replace it?

Do not adopt a literal zero-dependency policy for every TypeScript application.

Instead, maintain a **small, deliberate dependency set**.

Foundational libraries should face a much higher bar than development-only tooling.

Prefer built-in platform APIs when they are adequate.

---

# Abstractions

Every abstraction has a cost.

Do not create an interface, generic, class, factory, adapter, repository, manager, provider, service, or utility merely because such a layer might someday become useful.

Abstract when the domain contains a real concept that deserves a name.

Avoid:

```ts
class UserServiceManagerFactory {
	createUserServiceManager(): UserServiceManager {
		// ...
	}
}
```

when:

```ts
function createUser(...): User {
  // ...
}
```

describes the problem.

Prefer concrete code until the correct abstraction becomes visible.

Duplicating three understandable lines can be safer than introducing an abstraction that couples unrelated concepts.

At the same time, do not use "simplicity" as justification for allowing fundamental domain rules to be duplicated throughout the system.

Abstract invariants, not coincidences.

---

# Classes

Do not default to classes.

Use a class when identity, encapsulated mutable state, lifecycle, or polymorphism makes the model clearer.

Prefer plain types and functions for ordinary transformations:

```ts
type Rectangle = {
	width: number;
	height: number;
};

function rectangleArea(rectangle: Rectangle): number {
	return rectangle.width * rectangle.height;
}
```

Classes should protect meaningful invariants rather than merely group functions.

Avoid inheritance-based architecture unless the domain genuinely has substitutable hierarchical behavior.

Prefer composition.

---

# Comments

Always explain **why**.

Code often explains what it does. A useful comment explains information that is not otherwise recoverable from the code.

Good:

```ts
// Keep this below the database parameter limit so batches behave
// identically in production and the smaller integration-test database.
const INSERT_BATCH_SIZE_MAX = 500;
```

Bad:

```ts
// Increment index.
index++;
```

Comments should be grammatical prose.

Write test comments explaining methodology when a test depends on a non-obvious setup or invariant.

Do not use comments to compensate for bad names or unnecessarily convoluted code.

Fix the code first.

---

# Tests

Tests are executable claims about the design.

Test both the positive and negative space.

For a parser, test:

- minimum valid input;
- maximum valid input;
- just below the minimum;
- just above the maximum;
- empty input;
- malformed input;
- unexpected fields where relevant;
- missing fields;
- duplicated data;
- boundary numerical values.

For state machines, test every legal transition and important illegal transition.

For bugs, add a regression test that fails for the original reason.

Prefer deterministic tests.

Inject:

- time;
- randomness;
- IDs;
- external I/O;
- schedulers;

when deterministic control materially improves testing.

Avoid unnecessary mocking. A mock that reproduces the implementation's assumptions can allow both the test and implementation to be wrong together.

---

# Time

Time is external input.

Do not hide calls to the current clock deep inside business logic.

Avoid:

```ts
function isExpired(token: Token): boolean {
	return token.expiresAtMs < Date.now();
}
```

Prefer:

```ts
function isExpired(token: Token, nowUnixMs: number): boolean {
	return token.expiresAtUnixMs < nowUnixMs;
}
```

Acquire the current time at an appropriate boundary and pass it inward.

Name timestamps and durations distinctly.

A timestamp is not a duration.

---

# Randomness

Randomness is also external input.

Do not use `Math.random()` for security-sensitive values.

For ordinary randomized algorithms and tests, make randomness injectable when reproducibility matters.

A failed randomized test should be reproducible from its seed.

---

# APIs

Make APIs difficult to misuse.

Prefer domain concepts over primitive parameter lists.

Avoid:

```ts
transfer("123", "456", 1000, "USD", false);
```

Prefer:

```ts
transfer({
	sourceAccountId,
	targetAccountId,
	amountMinor: 1_000,
	currency: "USD",
	pending: false,
});
```

For monetary values, timestamps, identifiers, and similar concepts, consider dedicated types where mixing values would be dangerous.

Do not use booleans where an enum-like union communicates meaning better:

```ts
type TransferMode = "immediate" | "pending";
```

instead of:

```ts
pending: boolean;
```

when the distinction is central to the domain.

---

# Configuration

Parse configuration once during startup.

Fail early for invalid configuration.

Do not let arbitrary strings from `process.env` propagate throughout the application.

Prefer:

```ts
type Config = {
	readonly port: number;
	readonly databaseUrl: string;
	readonly requestTimeoutMs: number;
};

function loadConfig(environment: NodeJS.ProcessEnv): Config {
	return {
		port: parsePort(environment.PORT),
		databaseUrl: parseDatabaseUrl(environment.DATABASE_URL),
		requestTimeoutMs: parseDurationMs(environment.REQUEST_TIMEOUT_MS),
	};
}
```

After startup, application code should receive `Config`, not `process.env`.

Configuration should be immutable.

---

# Logging

Logging is I/O.

Logs have bandwidth, storage, privacy, and cost implications.

Do not dump arbitrary objects into logs.

Prefer structured events containing explicitly chosen fields.

Never assume an object is safe to log merely because TypeScript knows its type.

Do not log:

- passwords;
- access tokens;
- session secrets;
- cryptographic keys;
- unnecessary personal information.

Bound log field sizes.

A catastrophic failure should not become more catastrophic because the program attempted to serialize a 100 MB object into its error log.

---

# File Organization

Optimize source files for top-down reading.

Put the primary concept near the top.

A reasonable order is:

1. imports;
2. constants;
3. exported types;
4. primary exported function/class;
5. supporting functions;
6. private implementation details.

Do not create files containing one trivial function merely to satisfy an architectural convention.

Do not let unrelated functionality accumulate in generic files named:

```text
utils.ts
helpers.ts
common.ts
misc.ts
```

Name files after domain concepts.

---

# Formatting

Formatting is automated.

Use one formatter for the repository and do not manually debate formatter output.

For a typical TypeScript repository:

- use 2-space indentation;
- use a maximum line length of approximately 100 columns;
- require braces for control-flow statements;
- use trailing commas where supported by the formatter;
- keep formatting deterministic.

If an existing repository already uses another consistent indentation width, consistency wins.

No code should require horizontal scrolling during ordinary review.

Formatting belongs to tooling, not code review.

---

# Linting

Use linting primarily to catch correctness problems, not to encode personal aesthetic preferences.

High-value rules include detecting:

- floating promises;
- accidental `any`;
- unsafe assignments;
- unreachable code;
- incorrect promise handling;
- missing switch cases;
- unused suppression comments;
- accidental fallthrough.

Every lint suppression should be local and explain why the rule does not apply:

```ts
// The promise is intentionally owned by the process-level failure handler.
// eslint-disable-next-line @typescript-eslint/no-floating-promises
void runBackgroundWorker();
```

Never disable a safety rule for an entire repository simply to silence existing violations without understanding them.

---

# Tooling

Keep the project's toolbox small.

A typical codebase should not need several overlapping:

- formatters;
- test runners;
- bundlers;
- linters;
- package managers;
- schema systems;
- HTTP clients.

Standardize.

Prefer tools already present in the project unless a new tool creates a significant improvement.

Every additional tool expands the number of versions, configuration files, behaviors, and failure modes the team must understand.

Scripts should be portable and deterministic.

Prefer TypeScript/JavaScript scripts using platform APIs over large collections of shell scripts when the script contains meaningful program logic or must run consistently across operating systems.

---

# Suppressions

Escape hatches deserve scrutiny.

Examples include:

```ts
as SomeType
```

```ts
!
```

```ts
any;
```

```ts
@ts-ignore
```

```ts
@ts-expect-error
```

```ts
eslint - disable;
```

These are sometimes correct.

They should nevertheless make the reviewer ask:

> What invariant makes this safe?

Prefer `@ts-expect-error` over `@ts-ignore` when intentionally testing or documenting a compiler error, because it becomes unnecessary when the expected error disappears.

Keep suppressions as local as possible.

---

# Code Review

Review correctness before cosmetics.

Ask:

- What are the invariants?
- What is the maximum amount of work?
- What can grow?
- What can fail?
- What happens when it fails?
- What happens after an `await`?
- Which state is authoritative?
- Can this state be represented more precisely?
- Is external input validated?
- Is an impossible state actually impossible?
- Are all variants handled?
- Is there accidental quadratic work?
- Could concurrency become unbounded?
- Does this dependency justify its cost?
- Does the test cover the boundary?
- Does the comment explain why?

Review code as if the original author will not be available when it fails in production.

---

# Pull Requests and Commits

Commit messages are permanent documentation.

Explain why the change exists, not merely which files changed.

Avoid:

```text
fix stuff
```

Prefer:

```text
Bound webhook retry queue

An unavailable downstream service could previously cause retries to
accumulate without limit. Cap the queue and reject new retry work once
the configured capacity is reached.
```

Pull-request descriptions provide useful context, but they do not replace good commit messages or comments documenting non-obvious invariants.

---

# Style by the Numbers

Unless the repository has a stronger established convention:

- **100 columns maximum.**
- **70 lines maximum per function.**
- **2 spaces per indentation level.**
- **0 implicit `any`s.**
- **0 unhandled promises.**
- **0 unvalidated external inputs crossing into trusted domain code.**
- **0 unexplained type-system suppressions.**
- **Explicit bounds for every potentially unbounded resource.**
- **Strict TypeScript enabled.**
- **Formatter, compiler, linter, and tests run in CI.**

Do not optimize for the smallest number of lines.

Optimize for the smallest number of states a reader must hold in their head.

---

# The Last Stage

TypeScript makes it easy to build abstractions quickly.

Resist that speed just enough to understand the problem first.

Use the compiler aggressively, but remember that it cannot validate runtime reality for you. Use types to encode the model, assertions to encode invariants, parsers to defend boundaries, bounds to control resources, tests to attack assumptions, and simple code to make the whole system understandable.

Make the safe path the obvious path.

Then make it fast.
