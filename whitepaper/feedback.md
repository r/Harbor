# we need your input

**specific areas where your feedback matters most**

---

we've built something. we think it matters. but we don't have all the answers — and we're certain we've missed things.

Harbor is a sketch. it exists so we can have concrete conversations instead of abstract debates. point at the code. tell us what's wrong.

---

## what we're looking for

### use cases we haven't considered

we designed around scenarios we understood: research assistants, page summarization, shopping helpers, SaaS integrations.

the web is vast. help us see what we're missing:

- what would you build with this that we haven't described?
- what capabilities are missing for your use case?
- are there entire categories of applications we haven't imagined?

### API design feedback

the `window.ai` and `window.agent` surfaces are our first attempt.

tell us what's wrong:

- is anything confusing or awkward?
- are there operations that should be simpler?
- are there capabilities that should be more granular?
- should we use different patterns?

### security review

we've thought about security. we're not infallible.

break it:

- what attack vectors haven't we considered?
- are our mitigations sufficient?
- are there permission scopes that are too broad or too narrow?
- what could a malicious website do that we haven't accounted for?

### privacy analysis

privacy is core to this proposal.

find the holes:

- are there data flows we should restrict further?
- are there tracking vectors we've introduced?
- should certain operations require stronger consent?
- are there contexts where local-first should be enforced, not optional?

### enterprise and organizational needs

individual users have different needs than organizations.

tell us what's missing:

- what policy controls do organizations need?
- how should this interact with MDM and browser management?
- are there compliance requirements we should consider?

---

## questions we're actively debating

these are questions we don't have answers to. your input would help us decide.

### session persistence

should AI sessions persist across page reloads?

| for | against |
|-----|---------|
| enables long-running conversations | privacy implications |
| better UX for complex tasks | complexity in permission model |
| matches user expectations | storage and cleanup concerns |

**what we want to know:** would you use this? what would you build with it? what privacy controls would make you comfortable?

### cross-origin context sharing

should users be able to share context across origins?

| for | against |
|-----|---------|
| richer personalization | significant privacy risks |
| reduces repetition | complex consent model |
| supports "AI identity" | potential for abuse |

**what we want to know:** is this valuable enough to take on the risks? what consent mechanisms would make it acceptable?

### website-provided models

should websites provide their own models, not just tools?

| for | against |
|-----|---------|
| specialized models for domains | undermines "bring your own AI" |
| websites differentiate on quality | could bypass user preferences |
| supports fine-tuned models | complicates the mental model |

**what we want to know:** is there a middle ground? perhaps website-provided models only with explicit opt-in?

### payment and identity integration

should the API support payment authorization or identity verification?

| for | against |
|-----|---------|
| enables AI-assisted commerce | high-risk attack surface |
| supports authentication flows | scope creep |
| matches other browser capabilities | complex regulatory implications |

**what we want to know:** is this in scope? if so, what would minimal viable integration look like?

---

## how to share feedback

### GitHub Issues

for specific bugs, feature requests, or concrete suggestions:

→ [open an issue](https://github.com/anthropics/harbor/issues)

include: clear description, use case context, suggested changes if you have them.

### GitHub Discussions

for broader topics, questions, or exploration:

→ [start a discussion](https://github.com/anthropics/harbor/discussions)

good topics: use cases, alternative approaches, questions about rationale.

### Pull Requests

for documentation, examples, or implementation:

→ [contributing guide](../CONTRIBUTING.md)

we especially welcome: example applications, security improvements, test coverage.

### direct contact

for sensitive security issues:

→ security@mozilla.org

---

## what happens to feedback

we read everything.

- issues get triaged and addressed, scheduled, or discussed
- discussions inform our thinking even when they don't result in immediate changes
- PRs get reviewed and merged or discussed
- patterns in feedback lead to design changes

we try to respond to all feedback, though response times vary.

---

## community guidelines

we want this to be constructive.

**please:** be specific. explain your reasoning. consider tradeoffs. assume good faith.

**please don't:** dismiss without explanation. make demands without rationale. derail discussions.

---

*thank you for helping us build something better.*
