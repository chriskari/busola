import gql from 'graphql-tag';

export const GET_NAMESPACES = gql`
  query Namespaces(
    $showSystemNamespaces: Boolean
    $withInactiveStatus: Boolean
  ) {
    namespaces(
      withSystemNamespaces: $showSystemNamespaces
      withInactiveStatus: $withInactiveStatus
    ) {
      name
      labels
      status
      pods {
        status
      }
      applications
      isSystemNamespace
    }
  }
`;

export const GET_LAMBDAS = gql`
  query Functions($namespace: String!) {
    functions(namespace: $namespace) {
      name
      namespace
      labels
      runtime
      size
      status
    }
  }
`;

export const GET_LAMBDA = gql`
  query Function($name: String!, $namespace: String!) {
    function(name: $name, namespace: $namespace) {
      name
      namespace
      labels
      runtime
      size
      status
      content
      dependencies
    }
  }
`;

export const GET_SERVICES = gql`
  query Services($namespace: String!) {
    services(namespace: $namespace) {
      name
      ports {
        port
      }
    }
  }
`;