# Skills library

One folder per skill, each with a `SKILL.md`: frontmatter (`name`, `description`, `version`, `covers`) and a short procedure.

**Assigning.** An agent spec's `skills` list and a department's `skills` list name them. An agent's prompt carries only the one-line index, and it reads the body with `read_skill` when the work calls for it, so an unused skill costs almost nothing.

**Versioning.** Skills live in git and change through pull requests. Raise `version` when a change alters behaviour.

**Adding one.** Copy the shape of an existing skill. Agents can propose a skill in their report, but cannot write here: a skill is an instruction every later agent trusts, so a person reviews it.

**Third-party skills.** None are installed. Before adding one, read every file it contains, including scripts, and check what it runs, what it reaches on the network, and whether it asks for credentials or tells the agent to ignore its rules. Copy the reviewed text here at a pinned version. Do not install from a registry at runtime.

A skill is guidance. It cannot grant permission: the policy gate and the agent's capabilities decide what actually runs, and the hard limits written in these files are enforced there too.
