// #120: the worker image sets ASF_AGENT_USER (#68), and every runtime hands the agent its own env, so a
// tester's test run inherits it and spawnAgent/killTree would go through the as-agent helper. Tests start
// from the host default; those that need an agent user pass an explicit env or set it themselves.
delete process.env.ASF_AGENT_USER;
delete process.env.ASF_AGENT_HOME;
delete process.env.ASF_AS_AGENT;
